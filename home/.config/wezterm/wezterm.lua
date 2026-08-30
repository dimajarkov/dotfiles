local wezterm = require 'wezterm'
local config = wezterm.config_builder()

local function color_scheme_for_appearance(appearance)
  if appearance:find 'Dark' then
    return 'Catppuccin Mocha'
  end

  return 'Catppuccin Latte'
end

local function apply_appearance(window)
  local overrides = window:get_config_overrides() or {}
  local color_scheme = color_scheme_for_appearance(window:get_appearance())

  if overrides.color_scheme ~= color_scheme then
    overrides.color_scheme = color_scheme
    window:set_config_overrides(overrides)
  end
end

wezterm.on('update-status', function(window)
  apply_appearance(window)
end)

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
config.keys = keys

return config
