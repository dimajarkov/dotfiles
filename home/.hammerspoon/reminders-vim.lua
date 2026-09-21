local M = {}

local EVENT_SOURCE_USER_DATA = hs.eventtap.event.properties.eventSourceUserData
local REPLAY_MARKER = 0x524D564D
local REMINDERS_BUNDLE_ID = "com.apple.reminders"

local keycodes = hs.keycodes.map
-- VimAction already maps j/k to down/up. Only l/; need translation.
local remap = {
  [keycodes.l] = "h",
  [keycodes[";"]] = "l",
}
local digitKeys = {}
for _, digit in ipairs({ "1", "2", "3", "4", "5", "6", "7", "8", "9" }) do
  digitKeys[keycodes[digit]] = true
end
local objectKeys = {
  [keycodes.w] = true,
  [keycodes.b] = true,
  [keycodes["'"]] = true,
  [keycodes["`"]] = true,
  [keycodes["9"]] = true,
  [keycodes["0"]] = true,
  [keycodes["["]] = true,
  [keycodes["]"]] = true,
  [keycodes[","]] = true,
  [keycodes["."]] = true,
}

local function isRemindersFrontmost()
  local app = hs.application.frontmostApplication()
  return app ~= nil and app:bundleID() == REMINDERS_BUNDLE_ID
end

local function isPlain(flags)
  return not (flags.cmd or flags.alt or flags.ctrl or flags.shift or flags.fn)
end

local function isShifted(flags)
  return flags.shift
    and not (flags.cmd or flags.alt or flags.ctrl or flags.fn)
end

local function isCommandOnly(flags)
  return flags.cmd
    and not (flags.alt or flags.ctrl or flags.shift or flags.fn)
end

local function postKey(key)
  local down = hs.eventtap.event.newKeyEvent({}, key, true)
  local up = hs.eventtap.event.newKeyEvent({}, key, false)
  down:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  up:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  down:post()
  up:post()
end

local function postModifiedKey(modifiers, key)
  hs.eventtap.keyStroke(modifiers, key, 0)
end

local function axAttribute(element, name)
  local ok, value = pcall(function()
    return element:attributeValue(name)
  end)
  if ok then
    return value
  end
  return nil
end

local function findSidebarOutline(app)
  local window = app:mainWindow()
  if not window then
    return nil
  end

  local ok, root = pcall(hs.axuielement.windowElement, window)
  if not ok or not root then
    return nil
  end

  local outlines = {}
  local function walk(element, depth)
    if depth > 8 then
      return
    end
    if axAttribute(element, "AXRole") == "AXOutline" then
      table.insert(outlines, element)
    end
    for _, child in ipairs(axAttribute(element, "AXChildren") or {}) do
      walk(child, depth + 1)
    end
  end
  walk(root, 0)

  local sidebar
  local sidebarX
  for _, outline in ipairs(outlines) do
    local position = axAttribute(outline, "AXPosition")
    if position and (sidebarX == nil or position.x < sidebarX) then
      sidebar = outline
      sidebarX = position.x
    end
  end
  return sidebar
end

local function selectSidebarMenuItem(app, title)
  local ok, item = pcall(function()
    return app:findMenuItem({ "View", title })
  end)
  if not ok or not item or item.enabled == false then
    return false
  end

  return pcall(function()
    app:selectMenuItem({ "View", title })
  end)
end

local function showSidebar()
  local app = hs.application.get(REMINDERS_BUNDLE_ID)
  return app ~= nil and selectSidebarMenuItem(app, "Show Sidebar")
end

local function toggleSidebar()
  local app = hs.application.get(REMINDERS_BUNDLE_ID)
  if not app then
    return
  end

  if not selectSidebarMenuItem(app, "Show Sidebar") then
    selectSidebarMenuItem(app, "Hide Sidebar")
  end
end

local function indentReminder()
  postModifiedKey({ "cmd" }, "]")
end

local function focusSidebar()
  local app = hs.application.get(REMINDERS_BUNDLE_ID)
  if not app then
    return
  end

  if M.focusTimer then
    M.focusTimer:stop()
    M.focusTimer = nil
  end

  showSidebar()
  local attempts = 0
  local function tryFocus()
    attempts = attempts + 1
    if not isRemindersFrontmost() then
      M.focusTimer = nil
      return
    end

    local outline = findSidebarOutline(app)
    if outline then
      pcall(function()
        outline:setAttributeValue("AXFocused", true)
      end)
      M.focusTimer = nil
      return
    end

    if attempts < 6 then
      M.focusTimer = hs.timer.doAfter(0.1, tryFocus)
    end
  end

  M.focusTimer = hs.timer.doAfter(0.1, tryFocus)
end

local function reset(state)
  state.mode = "insert"
  state.visualWise = nil
  state.sidebarFocused = false
  state.pending = nil
end

local function finishOperator(state, operator)
  state.pending = nil
  if operator == "c" then
    state.mode = "insert"
  end
end

local function handlePending(state, code, flags)
  local pending = state.pending
  if pending == nil then
    return false
  end

  if code == keycodes.escape then
    state.pending = nil
    return false
  end

  if pending.prefix == "g" then
    if code == keycodes.g and isPlain(flags) then
      finishOperator(state, pending.operator)
    else
      state.pending = nil
    end
    return false
  end

  if pending.prefix == "object" then
    if objectKeys[code] then
      finishOperator(state, pending.operator)
    else
      state.pending = nil
    end
    return false
  end

  if isPlain(flags) and (code == keycodes.i or code == keycodes.a) then
    pending.prefix = "object"
    return false
  end

  if isPlain(flags) and code == keycodes.g then
    pending.prefix = "g"
    return false
  end

  if isPlain(flags) and digitKeys[code] then
    pending.count = true
    return false
  end

  if isPlain(flags) and code == keycodes["0"] then
    if pending.count then
      return false
    end
    finishOperator(state, pending.operator)
    return false
  end

  if isPlain(flags) and code == keycodes[pending.operator] then
    finishOperator(state, pending.operator)
    return false
  end

  if isPlain(flags) and remap[code] ~= nil then
    if pending.operator == "c" then
      state.mode = "insert"
    end
    state.pending = nil
    postKey(remap[code])
    return true
  end

  if isPlain(flags) or isShifted(flags) then
    if pending.operator == "c" and (
      code == keycodes.h
        or code == keycodes.j
        or code == keycodes.k
        or code == keycodes.w
        or code == keycodes.b
        or code == keycodes.e
        or code == keycodes["0"]
        or (code == keycodes["6"] and isShifted(flags))
        or (code == keycodes["4"] and isShifted(flags))
        or (code == keycodes.g and isShifted(flags))
    ) then
      state.mode = "insert"
    end
    state.pending = nil
  end

  return false
end

local function handleNormalLike(state, code, flags)
  if state.pending ~= nil then
    return handlePending(state, code, flags)
  end

  if not isPlain(flags) and not isShifted(flags) then
    return false
  end

  if isPlain(flags) and remap[code] ~= nil then
    postKey(remap[code])
    return true
  end

  -- h is intentionally no longer a bare motion in Reminders. Keep it
  -- available after an operator so VimAction's internal command is not left
  -- pending if an old binding is used accidentally.
  if isPlain(flags) and code == keycodes.h then
    return true
  end

  if isPlain(flags)
    and (
      code == keycodes.i
        or code == keycodes.a
        or code == keycodes.o
        or code == keycodes.s
    )
    or isShifted(flags)
    and (
      code == keycodes.i
        or code == keycodes.a
        or code == keycodes.o
        or code == keycodes.s
        or code == keycodes.c
    )
  then
    state.mode = "insert"
    return false
  end

  if isPlain(flags) and code == keycodes.c then
    state.pending = { operator = "c" }
    return false
  end

  if isPlain(flags) and (code == keycodes.d or code == keycodes.y) then
    state.pending = { operator = code == keycodes.d and "d" or "y" }
    return false
  end

  if isPlain(flags) and code == keycodes.g then
    state.pending = { prefix = "g" }
    return false
  end

  if isPlain(flags) and code == keycodes.v then
    state.mode = "visual-char"
    return false
  end

  if isShifted(flags) and code == keycodes.v then
    state.mode = "visual-line"
    return false
  end

  return false
end

local function handleKey(state, event)
  if event:getProperty(EVENT_SOURCE_USER_DATA) == REPLAY_MARKER then
    return false
  end

  if not isRemindersFrontmost() then
    reset(state)
    return false
  end

  local code = event:getKeyCode()
  local flags = event:getFlags()

  if code == keycodes.escape and not flags.cmd and not flags.alt
    and not flags.ctrl and not flags.shift and not flags.fn
  then
    state.mode = "normal"
    state.pending = nil
    return false
  end

  if code == keycodes["["] and flags.ctrl and not flags.cmd
    and not flags.alt and not flags.shift and not flags.fn
  then
    state.mode = "normal"
    state.pending = nil
    return false
  end

  -- These controls are always available while Reminders is frontmost,
  -- including while editing a reminder title.
  if isCommandOnly(flags) and code == keycodes.b then
    state.sidebarFocused = false
    state.pending = nil
    toggleSidebar()
    return true
  end

  if isCommandOnly(flags) and code == keycodes.e then
    state.sidebarFocused = true
    state.pending = nil
    focusSidebar()
    return true
  end

  if isPlain(flags) and code == keycodes.tab then
    state.pending = nil
    indentReminder()
    return true
  end

  if state.mode == "insert" then
    return false
  end

  if state.mode == "visual-char" or state.mode == "visual-line" then
    if not isPlain(flags) and not isShifted(flags) then
      return false
    end

    if state.pending and state.pending.prefix == "g" then
      state.pending = nil
      return false
    end

    if isPlain(flags) and code == keycodes.g then
      state.pending = { prefix = "g" }
      return false
    end

    if isPlain(flags) and remap[code] ~= nil then
      postKey(remap[code])
      return true
    end

    if isPlain(flags) and code == keycodes.h then
      return true
    end

    if isPlain(flags) and code == keycodes.v then
      if state.mode == "visual-char" then
        state.mode = "normal"
      else
        state.mode = "visual-char"
      end
    elseif isShifted(flags) and code == keycodes.v then
      if state.mode == "visual-line" then
        state.mode = "normal"
      else
        state.mode = "visual-line"
      end
    elseif state.pending == nil
      and (isPlain(flags) and (code == keycodes.c or code == keycodes.s)
        or isShifted(flags) and code == keycodes.s)
    then
      state.mode = "insert"
    elseif state.pending == nil and isPlain(flags)
      and (code == keycodes.d or code == keycodes.x or code == keycodes.y)
    then
      state.mode = "normal"
    end

    return false
  end

  return handleNormalLike(state, code, flags)
end

function M.start()
  if M.keyTap then
    M.keyTap:stop()
  end
  if M.appWatcher then
    M.appWatcher:stop()
  end
  if M.focusTimer then
    M.focusTimer:stop()
    M.focusTimer = nil
  end
  local state = M.state or { mode = "insert", pending = nil }
  M.state = state
  reset(state)

  M.keyTap = hs.eventtap.new(
    { hs.eventtap.event.types.keyDown },
    function(event)
      return handleKey(state, event)
    end
  )
  M.keyTap:start()

  M.appWatcher = hs.application.watcher.new(function(_, event, app)
    local bundleID = app and app:bundleID()
    if event == hs.application.watcher.deactivated
      and bundleID == REMINDERS_BUNDLE_ID
    then
      reset(state)
    elseif event == hs.application.watcher.activated
      and bundleID ~= REMINDERS_BUNDLE_ID
    then
      reset(state)
    end
  end)
  M.appWatcher:start()
end

return M
