require("hs.ipc")
hs.autoLaunch(true)

-- Retain long-lived Hammerspoon objects so garbage collection cannot disable them.
local arcNavigation = {}
_G.arcNavigation = arcNavigation

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

arcNavigation.configWatchers = {}
for _, directory in ipairs(configDirectories) do
  table.insert(
    arcNavigation.configWatchers,
    hs.pathwatcher.new(directory, reloadConfig):start()
  )
end

-- Arc navigation using backslash as a Vim-style leader.
--
-- Backslash+e: toggle the Arc sidebar.
-- While the sidebar is visible, j/k select the next/previous tab.
-- Backslash+t: open Arc's command bar to search the web or open a URL.
-- Backslash+h: add Arc Split View.
-- Backslash+;: focus split pane 2 (right, or bottom in a vertical split).
-- Backslash+l: focus split pane 1 (left, or top in a vertical split).
-- Backslash+x: close the current tab, or the current pane in Split View.

local PREFIX_TIMEOUT = 1.25
local BACKSLASH_KEY = 42
local E_KEY = 14
local H_KEY = 4
local T_KEY = 17
local J_KEY = 38
local K_KEY = 40
local L_KEY = 37
local SEMICOLON_KEY = 41
local X_KEY = 7
local REPLAY_MARKER = 0x56494D
local EVENT_SOURCE_USER_DATA = hs.eventtap.event.properties.eventSourceUserData

local waitingForPrefix = false
local prefixTimer = nil

local function isArcFrontmost()
  local app = hs.application.frontmostApplication()
  return app ~= nil and app:name() == "Arc"
end

local function isPlainKey(flags)
  return not (flags.cmd or flags.alt or flags.ctrl or flags.shift or flags.fn)
end

local function isArcSidebarVisible()
  local app = hs.application.frontmostApplication()
  return app ~= nil
    and app:name() == "Arc"
    and app:findMenuItem({ "View", "Hide Sidebar" }) ~= nil
end

local function stopPrefixTimer()
  if prefixTimer then
    prefixTimer:stop()
    prefixTimer = nil
  end
end

local function postMarkedKey(key, isDown)
  local event = hs.eventtap.event.newKeyEvent({}, key, isDown)
  event:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  event:post()
end

local function replayPrefix()
  postMarkedKey("\\", true)
  postMarkedKey("\\", false)
end

local function replayPrefixAndEvent(event)
  stopPrefixTimer()
  waitingForPrefix = false
  replayPrefix()

  local replayedEvent = event:copy()
  replayedEvent:setProperty(EVENT_SOURCE_USER_DATA, REPLAY_MARKER)
  replayedEvent:post()
end

local function cancelPrefix(replay)
  stopPrefixTimer()
  if waitingForPrefix and replay then
    replayPrefix()
  end
  waitingForPrefix = false
end

local function sendArcShortcut(key)
  hs.eventtap.keyStroke({ "ctrl", "shift" }, key, 0)
end

local function selectAdjacentSidebarTab(key)
  hs.eventtap.keyStroke({ "cmd", "alt" }, key, 0)
end

local function closeCurrentArcItem()
  local app = hs.application.frontmostApplication()
  local splitPaneItem = app and app:findMenuItem({ "View", "Close this Split Pane" })

  local menuPath = splitPaneItem and splitPaneItem.enabled
      and { "View", "Close this Split Pane" }
    or { "File", "Archive Tab" }

  hs.timer.doAfter(0, function()
    local currentApp = hs.application.frontmostApplication()
    if currentApp and currentApp:name() == "Arc" then
      currentApp:selectMenuItem(menuPath)
    end
  end)
end

local keyTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
  if event:getProperty(EVENT_SOURCE_USER_DATA) == REPLAY_MARKER then
    return false
  end

  if not isArcFrontmost() or hs.eventtap.isSecureInputEnabled() then
    cancelPrefix(false)
    return false
  end

  local keyCode = event:getKeyCode()
  local flags = event:getFlags()

  if not waitingForPrefix then
    if keyCode == BACKSLASH_KEY and isPlainKey(flags) then
      waitingForPrefix = true
      stopPrefixTimer()
      prefixTimer = hs.timer.doAfter(PREFIX_TIMEOUT, function()
        if waitingForPrefix then
          cancelPrefix(true)
        end
      end)
      return true
    end

    if
      isPlainKey(flags)
      and (keyCode == J_KEY or keyCode == K_KEY)
      and isArcSidebarVisible()
    then
      selectAdjacentSidebarTab(keyCode == J_KEY and "down" or "up")
      return true
    end

    return false
  end

  if not isPlainKey(flags) then
    replayPrefixAndEvent(event)
    return true
  end

  if keyCode == E_KEY then
    cancelPrefix(false)
    hs.eventtap.keyStroke({ "cmd" }, "s", 0)
    return true
  end

  if keyCode == T_KEY then
    cancelPrefix(false)
    hs.eventtap.keyStroke({ "cmd" }, "t", 0)
    return true
  end

  if keyCode == H_KEY then
    cancelPrefix(false)
    sendArcShortcut("=")
    return true
  end

  if keyCode == SEMICOLON_KEY then
    cancelPrefix(false)
    sendArcShortcut("2")
    return true
  end

  if keyCode == L_KEY then
    cancelPrefix(false)
    sendArcShortcut("1")
    return true
  end

  if keyCode == X_KEY then
    cancelPrefix(false)
    closeCurrentArcItem()
    return true
  end

  replayPrefixAndEvent(event)
  return true
end)

arcNavigation.keyTap = keyTap
keyTap:start()

local status = hs.menubar.new()
arcNavigation.status = status
if status then
  status:setTitle("Arc⌗")
  status:setMenu({
    { title = "Arc leader mappings active", disabled = true },
    { title = "\\e  Toggle sidebar + j/k navigation", disabled = true },
    { title = "j/k  Next/previous tab while sidebar is visible", disabled = true },
    { title = "\\t  Search the web or open a URL", disabled = true },
    { title = "\\h  Split View", disabled = true },
    { title = "\\;  Focus right/bottom pane", disabled = true },
    { title = "\\l  Focus left/top pane", disabled = true },
    { title = "\\x  Close current tab or split pane", disabled = true },
    { title = "Reload Hammerspoon Config", fn = hs.reload },
  })
end
