local wezterm = require 'wezterm'
local config = wezterm.config_builder()

local function color_scheme_for_appearance(appearance)
  if appearance:find 'Dark' then
    return 'Catppuccin Mocha'
  end

  return 'Catppuccin Latte'
end

local preview_color_schemes = {
  'Catppuccin Mocha',
  'Tokyo Night',
  'Dracula',
  'nord',
  'Gruvbox dark, hard (base16)',
  'One Dark (Gogh)',
  'Kanagawa (Gogh)',
  'Everforest Dark (Gogh)',
  'Rosé Pine (base16)',
  'Solarized (dark) (terminal.sexy)',
  'Catppuccin Latte',
}

local builtin_color_schemes = wezterm.get_builtin_color_schemes()
local recommended_color_schemes = {}
local color_scheme_choices = {
  { label = 'Follow system appearance', id = '__system__' },
}

for _, color_scheme in ipairs(preview_color_schemes) do
  if builtin_color_schemes[color_scheme] then
    recommended_color_schemes[color_scheme] = true
    table.insert(color_scheme_choices, {
      label = 'Try: ' .. color_scheme,
      id = color_scheme,
    })
  end
end

local other_color_schemes = {}
for color_scheme in pairs(builtin_color_schemes) do
  if not recommended_color_schemes[color_scheme] then
    table.insert(other_color_schemes, color_scheme)
  end
end
table.sort(other_color_schemes, function(left, right)
  return left:lower() < right:lower()
end)
for _, color_scheme in ipairs(other_color_schemes) do
  table.insert(color_scheme_choices, {
    label = color_scheme,
    id = color_scheme,
  })
end

local function apply_appearance(window)
  local overrides = window:get_config_overrides() or {}
  local color_scheme = wezterm.GLOBAL.color_scheme or color_scheme_for_appearance(window:get_appearance())

  if overrides.color_scheme ~= color_scheme then
    overrides.color_scheme = color_scheme
    window:set_config_overrides(overrides)
  end
end

wezterm.on('update-status', function(window)
  apply_appearance(window)
end)

local color_scheme_picker = wezterm.action.InputSelector {
  title = 'Select a color scheme',
  choices = color_scheme_choices,
  fuzzy = true,
  action = wezterm.action_callback(function(window, _, color_scheme)
    if not color_scheme then
      return
    end

    if color_scheme == '__system__' then
      wezterm.GLOBAL.color_scheme = nil
    else
      wezterm.GLOBAL.color_scheme = color_scheme
    end
    apply_appearance(window)
  end),
}

local function cycle_color_scheme(window, direction)
  local current_scheme = wezterm.GLOBAL.color_scheme or color_scheme_for_appearance(window:get_appearance())
  local current_index = 0

  for index, color_scheme in ipairs(preview_color_schemes) do
    if color_scheme == current_scheme then
      current_index = index
      break
    end
  end

  local next_index
  if current_index == 0 then
    next_index = direction > 0 and 1 or #preview_color_schemes
  else
    next_index = ((current_index - 1 + direction) % #preview_color_schemes) + 1
  end

  local color_scheme = preview_color_schemes[next_index]
  wezterm.GLOBAL.color_scheme = color_scheme
  apply_appearance(window)
  window:toast_notification('WezTerm color scheme', color_scheme, 1800, false)
end

local initial_appearance = 'Dark'
if wezterm.gui then
  initial_appearance = wezterm.gui.get_appearance()
end
config.color_scheme = color_scheme_for_appearance(initial_appearance)
config.status_update_interval = 500
config.font = wezterm.font 'Hack Nerd Font'
config.font_size = 14.0
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = 'RESIZE'
config.window_background_opacity = 0.98

-- Keep the content-only window and the Hide Others shortcut.
config.enable_tab_bar = false

local hide_other_apps = [[
tell application "System Events"
    set frontmostProcess to first application process whose frontmost is true
    set frontmostName to name of frontmostProcess
    repeat with processRef in application processes
        try
            if visible of processRef and name of processRef is not frontmostName then
                set visible of processRef to false
            end if
        end try
    end repeat
end tell
]]

local hide_other_apps_action = wezterm.action_callback(function()
    wezterm.run_child_process({ 'osascript', '-e', hide_other_apps })
end)

-- Extend WezTerm's defaults instead of replacing its built-in shortcuts.
local keys = {}
if wezterm.gui and wezterm.gui.default_keys then
  keys = wezterm.gui.default_keys()
end
table.insert(keys, {
    key = 'h',
    mods = 'ALT|SUPER',
    action = hide_other_apps_action,
})
table.insert(keys, {
    key = 'h',
    mods = 'ALT|CTRL',
    action = hide_other_apps_action,
})
table.insert(keys, {
    key = 't',
    mods = 'ALT|SUPER',
    action = color_scheme_picker,
})
table.insert(keys, {
    key = '[',
    mods = 'ALT|SUPER',
    action = wezterm.action_callback(function(window)
      cycle_color_scheme(window, -1)
    end),
})
table.insert(keys, {
    key = ']',
    mods = 'ALT|SUPER',
    action = wezterm.action_callback(function(window)
      cycle_color_scheme(window, 1)
    end),
})

-- Forward modified paging keys to pane applications instead of letting
-- WezTerm's built-in host scrollback bindings consume them.
table.insert(keys, {
    key = 'PageUp',
    mods = 'SHIFT',
    action = wezterm.action.SendString '\027[5;2~',
})
table.insert(keys, {
    key = 'PageDown',
    mods = 'SHIFT',
    action = wezterm.action.SendString '\027[6;2~',
})

config.keys = keys

return config
