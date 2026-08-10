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

config.color_scheme = color_scheme_for_appearance(wezterm.gui.get_appearance())
config.status_update_interval = 500
config.font = wezterm.font 'Hack Nerd Font'
config.font_size = 14.0
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = 'RESIZE'
config.window_background_opacity = 0.98
return config
