package.preload["hs.ipc"] = function()
  return {}
end

local mode = assert(arg[1])
local initPath = assert(arg[2])
local buttonPresses = 0
local selectedMenuItems = {}
local timers = {}
local button
local keyTapCallback
local hoveredQueries = 0

local function element(attributes, parent)
  return {
    attributeValue = function(_, name)
      if name == "AXParent" then
        return parent
      end
      local value = attributes[name]
      if value == nil then
        error("missing attribute")
      end
      return value
    end,
    performAction = function(_, action)
      assert(action == "AXPress")
      buttonPresses = buttonPresses + 1
    end,
  }
end

local window = {
  frame = function()
    return { x = 0, y = 0, w = 1200, h = 800 }
  end,
}
local scrollArea = element({
  AXRole = "AXScrollArea",
  AXPosition = { x = 0, y = 0 },
  AXSize = { w = 200, h = 500 },
})
local outline = element({ AXRole = "AXOutline" }, scrollArea)
local app = {
  bundleID = function()
    return "company.thebrowser.Browser"
  end,
  pid = function()
    return 41
  end,
  focusedWindow = function()
    return window
  end,
  mainWindow = function()
    return window
  end,
  selectMenuItem = function(_, path)
    selectedMenuItems[#selectedMenuItems + 1] = path
  end,
}

local hs = {
  configdir = "/test/hammerspoon",
  autoLaunch = function() end,
  alert = { show = function() end },
  application = {
    get = function()
      return app
    end,
    open = function()
      return app
    end,
    frontmostApplication = function()
      return app
    end,
  },
  axuielement = {
    systemElementAtPosition = function()
      hoveredQueries = hoveredQueries + 1
      return button
    end,
  },
  eventtap = {
    event = {
      properties = { eventSourceUserData = "sourceUserData" },
      types = { keyDown = "keyDown" },
      newKeyEvent = function()
        return {
          setProperty = function() end,
          post = function() end,
        }
      end,
    },
    isSecureInputEnabled = function()
      return false
    end,
    keyStroke = function() end,
    keyStrokes = function() end,
    new = function(_, callback)
      keyTapCallback = callback
      return {
        start = function(self)
          return self
        end,
        stop = function() end,
      }
    end,
  },
  fs = {
    pathToAbsolute = function(path)
      return path
    end,
  },
  hotkey = { bind = function() return {} end },
  keycodes = {
    map = {
      ["\\"] = 92,
      x = 120,
      l = 108,
      [";"] = 59,
      j = 106,
      k = 107,
      h = 104,
      v = 118,
    },
  },
  mouse = { absolutePosition = function() return { x = 20, y = 20 } end },
  pathwatcher = {
    new = function()
      return { start = function(self) return self end }
    end,
  },
  reload = function() end,
  timer = {
    doAfter = function(_, callback)
      local timer = {
        callback = callback,
        stop = function(self)
          self.stopped = true
        end,
      }
      timers[#timers + 1] = timer
      return timer
    end,
  },
}

_G.hs = hs
dofile(initPath)

local title = mode == "small" and "" or "A regular tab"
local size = mode == "small" and { w = 20, h = 20 } or { w = 180, h = 40 }
button = element({ AXRole = "AXButton", AXTitle = title, AXSize = size }, outline)

local function keyEvent(keyCode)
  return {
    getProperty = function()
      return nil
    end,
    getKeyCode = function()
      return keyCode
    end,
    getFlags = function()
      return {}
    end,
  }
end

local leaderConsumed = keyTapCallback(keyEvent(hs.keycodes.map["\\"]))
local commandConsumed = keyTapCallback(keyEvent(hs.keycodes.map.x))
assert(leaderConsumed == true)
assert(commandConsumed == true)
assert(hoveredQueries == 1, "expected one hovered-tab lookup, got " .. hoveredQueries)

if mode == "small" then
  assert(buttonPresses == 0)
  assert(#selectedMenuItems == 0)
else
  assert(buttonPresses == 1, "expected one AXPress, got " .. buttonPresses)
  assert(#timers == 2)
  timers[#timers].callback()
  assert(#selectedMenuItems == 1)
  assert(selectedMenuItems[1][1] == "File")
  assert(selectedMenuItems[1][2] == "Archive Tab")
end
