local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.color_scheme = 'OneDark (base16)'
config.font_size = 14.0
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = 'RESIZE'
config.window_background_opacity = 0.98
return config
