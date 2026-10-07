require("hs.ipc")
hs.autoLaunch(true)

-- Retain long-lived Hammerspoon objects so garbage collection cannot disable them.
local hammerspoonConfig = {}
_G.hammerspoonConfig = hammerspoonConfig

-- Switch apps and bring every open window for the app to the front.
-- Raycast's app launcher focuses only the app's key window.
local appNavigation = {}
_G.appNavigation = appNavigation
appNavigation.bindings = {
  ["1"] = { bundleID = "com.github.wez.wezterm", label = "WezTerm" },
  ["2"] = { bundleID = "com.microsoft.VSCode", label = "Visual Studio Code" },
  ["3"] = { bundleID = "app.zen-browser.zen", label = "Zen Browser" },
  ["4"] = { bundleID = "com.openai.codex", label = "ChatGPT" },
  ["0"] = { bundleID = "com.hnc.Discord", label = "Discord" },
  ["5"] = { bundleID = "com.cron.electron", label = "Notion Calendar" },
  [";"] = { bundleID = "com.gingerlabs.Notability", label = "Notability" },
}
appNavigation.hotkeys = {}

local function focusApplication(binding)
  local app = hs.application.get(binding.bundleID)
  if not app then
    app = hs.application.open(binding.bundleID, 1, true)
  end

  if not app then
    hs.alert.show("Could not open " .. binding.label)
    return
  end

  app:unhide()
  app:activate(true)
end

for key, binding in pairs(appNavigation.bindings) do
  appNavigation.hotkeys[key] = hs.hotkey.bind({ "cmd" }, key, function()
    focusApplication(binding)
  end)
end

-- Arc navigation using backslash as a Vim-style leader.
-- The leader is consumed only for Arc actions; a lone backslash is replayed
-- after the timeout so normal text entry remains possible in every app.
local arcNavigation = _G.arcNavigation or {}
_G.arcNavigation = arcNavigation

local function stopStoredTimer(name)
  local timer = arcNavigation[name]
  if timer then
    timer:stop()
    arcNavigation[name] = nil
  end
end

stopStoredTimer("prefixTimer")
stopStoredTimer("commandTimer")
stopStoredTimer("archiveTimer")
stopStoredTimer("openGoogleTimer")
stopStoredTimer("openGoogleSubmitTimer")

if arcNavigation.keyTap then
  arcNavigation.keyTap:stop()
end

local PREFIX_TIMEOUT = 1.25
local REPLAY_MARKER = 0x56494D
local EVENT_SOURCE_USER_DATA = hs.eventtap.event.properties.eventSourceUserData
local keycodes = hs.keycodes.map

local function isArcFrontmost()
  local app = hs.application.frontmostApplication()
  return app ~= nil and app:bundleID() == "company.thebrowser.Browser"
end

local function isPlainKey(flags)
  return not (flags.cmd or flags.alt or flags.ctrl or flags.shift or flags.fn)
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

local function isArcSidebarTabButton(element, window)
  local frame = window:frame()
  local sawTabContainer = false
  local current = element

  while current do
    local role = axAttribute(current, "AXRole")
    if role == "AXOutline" then
      sawTabContainer = true
    elseif
      role == "AXList"
      and axAttribute(current, "AXSubrole") == "AXSectionList"
    then
      sawTabContainer = true
    elseif role == "AXScrollArea" and sawTabContainer then
      local position = axAttribute(current, "AXPosition")
      local size = axAttribute(current, "AXSize")
      if
        position
        and size
        and math.abs(position.x - frame.x) <= 24
        and size.w <= math.min(600, frame.w * 0.5)
        and size.h >= 100
      then
        return true
      end
    end
    current = axAttribute(current, "AXParent")
  end

  return false
end

local function hoveredArcTabButton(app)
  local window = app:focusedWindow() or app:mainWindow()
  if not window then
    return nil
  end

  local element = hs.axuielement.systemElementAtPosition(hs.mouse.absolutePosition())
  while element do
    if axAttribute(element, "AXRole") == "AXButton" then
      if isArcSidebarTabButton(element, window) then
        return element
      end
      return nil
    end
    element = axAttribute(element, "AXParent")
  end
  return nil
end

local function postMarkedKey(key, isDown)
  local event = hs.eventtap.event.newKeyEvent({}, key, isDown)
  event:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  event:post()
end

local waitingForPrefix = false
local prefixApplicationPid
local prefixTimer

local function stopPrefixTimer()
  if prefixTimer then
    prefixTimer:stop()
    prefixTimer = nil
  end
  arcNavigation.prefixTimer = nil
end

local function replayPrefix()
  postMarkedKey("\\", true)
  postMarkedKey("\\", false)
end

local function clearPrefix(replay)
  stopPrefixTimer()
  if waitingForPrefix and replay then
    local app = hs.application.frontmostApplication()
    if app and app:pid() == prefixApplicationPid then
      replayPrefix()
    end
  end
  waitingForPrefix = false
  prefixApplicationPid = nil
end

local function replayPrefixAndEvent(event)
  clearPrefix(false)
  replayPrefix()

  local replayedEvent = event:copy()
  replayedEvent:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  replayedEvent:post()
end

local function sendArcShortcut(modifiers, key)
  hs.eventtap.keyStroke(modifiers, key, 0)
end

local function addRightArcSplit()
  local app = hs.application.frontmostApplication()
  if app and app:bundleID() == "company.thebrowser.Browser" then
    app:selectMenuItem({ "View", "Add Split View" })
  end
end

local function runArcCommand(command)
  stopStoredTimer("commandTimer")
  if not isArcFrontmost() then
    return
  end

  sendArcShortcut({ "cmd" }, "t")
  arcNavigation.commandTimer = hs.timer.doAfter(0.25, function()
    arcNavigation.commandTimer = nil
    if not isArcFrontmost() then
      return
    end

    hs.eventtap.keyStrokes(command)
    arcNavigation.commandTimer = hs.timer.doAfter(0.15, function()
      arcNavigation.commandTimer = nil
      if isArcFrontmost() then
        sendArcShortcut({}, "return")
      end
    end)
  end)
end

local function archiveHoveredArcTab()
  local app = hs.application.frontmostApplication()
  local button = app and hoveredArcTabButton(app)
  if not button then
    return
  end

  local title = axAttribute(button, "AXTitle")
  local size = axAttribute(button, "AXSize")
  local smallUntitledButton = (title == nil or title == "")
    and size
    and size.w < 60
    and size.h < 60

  if smallUntitledButton then
    return
  end

  local ok = pcall(function()
    button:performAction("AXPress")
  end)
  if not ok then
    return
  end

  stopStoredTimer("archiveTimer")
  arcNavigation.archiveTimer = hs.timer.doAfter(0.15, function()
    arcNavigation.archiveTimer = nil
    local currentApp = hs.application.frontmostApplication()
    if currentApp and currentApp:bundleID() == "company.thebrowser.Browser" then
      currentApp:selectMenuItem({ "File", "Archive Tab" })
    end
  end)
end

local arcKeyTap = hs.eventtap.new(
  { hs.eventtap.event.types.keyDown },
  function(event)
    if event:getProperty(EVENT_SOURCE_USER_DATA) == REPLAY_MARKER then
      return false
    end

    if hs.eventtap.isSecureInputEnabled() then
      clearPrefix(false)
      return false
    end

    local app = hs.application.frontmostApplication()
    if waitingForPrefix and (not app or app:pid() ~= prefixApplicationPid) then
      clearPrefix(false)
    end
    if not app or app:bundleID() ~= "company.thebrowser.Browser" then
      return false
    end

    local keyCode = event:getKeyCode()
    local flags = event:getFlags()

    if not waitingForPrefix then
      if keyCode == keycodes["\\"] and isPlainKey(flags) then
        waitingForPrefix = true
        prefixApplicationPid = app:pid()
        stopPrefixTimer()
        prefixTimer = hs.timer.doAfter(PREFIX_TIMEOUT, function()
          if waitingForPrefix then
            clearPrefix(true)
          end
        end)
        arcNavigation.prefixTimer = prefixTimer
        return true
      end
      return false
    end

    if not isPlainKey(flags) then
      replayPrefixAndEvent(event)
      return true
    end

    if keyCode == keycodes.x then
      clearPrefix(false)
      archiveHoveredArcTab()
      return true
    end

    if keyCode == keycodes.l then
      clearPrefix(false)
      sendArcShortcut({ "ctrl", "shift" }, "1")
      return true
    end

    if keyCode == keycodes[";"] then
      clearPrefix(false)
      sendArcShortcut({ "ctrl", "shift" }, "2")
      return true
    end

    if keyCode == keycodes.j then
      clearPrefix(false)
      sendArcShortcut({ "cmd", "alt" }, "down")
      return true
    end

    if keyCode == keycodes.k then
      clearPrefix(false)
      sendArcShortcut({ "cmd", "alt" }, "up")
      return true
    end

    if keyCode == keycodes.h then
      clearPrefix(false)
      addRightArcSplit()
      return true
    end

    if keyCode == keycodes.v then
      clearPrefix(false)
      runArcCommand("Add Top Split")
      return true
    end

    replayPrefixAndEvent(event)
    return true
  end
)

arcNavigation.keyTap = arcKeyTap
arcKeyTap:start()

local function reloadConfig(changedPaths)
  for _, path in ipairs(changedPaths) do
    if path:match("%.lua$") then
      hs.reload()
      return
    end
  end
end

local configFile = hs.fs.pathToAbsolute(hs.configdir .. "/init.lua")
local configSourceDirectory = configFile:match("^(.+)/[^/]+$")
local configDirectories = { hs.configdir }

if configSourceDirectory ~= hs.configdir then
  table.insert(configDirectories, configSourceDirectory)
end

hammerspoonConfig.configWatchers = {}
for _, directory in ipairs(configDirectories) do
  table.insert(
    hammerspoonConfig.configWatchers,
    hs.pathwatcher.new(directory, reloadConfig):start()
  )
end
