-- Run from the repo root: nvim --headless -u NONE -l tests/nvim-appearance.lua
-- Uses the real installed colorschemes; only the OS process boundary is faked.
vim.opt.runtimepath:prepend(vim.fn.getcwd() .. '/home/.config/nvim')
vim.cmd('packadd github-nvim-theme')
require('github-theme').setup()

local original_system = vim.system
local original_has = vim.fn.has
local result = {
	code = 1,
	stdout = '',
	stderr = 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist\n',
}
local calls = 0
local delayed = false
local callbacks = {}
vim.fn.has = function(feature)
	return feature == 'macunix' and 1 or original_has(feature)
end
vim.system = function(command, opts, callback)
	assert(vim.deep_equal(command, { '/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle' }))
	assert(opts.text and opts.timeout > 0, 'appearance probes must have a timeout')
	calls = calls + 1
	local response = vim.deepcopy(result)
	if callback then
		if delayed then
			table.insert(callbacks, function() callback(response) end)
		else
			vim.schedule(function() callback(response) end)
		end
	end
	return { wait = function() return response end, kill = function() end }
end

local function check(background, colorscheme)
	assert(vim.o.background == background, 'expected ' .. background .. ', got ' .. vim.o.background)
	assert(vim.g.colors_name == colorscheme,
		'expected ' .. colorscheme .. ', got ' .. tostring(vim.g.colors_name))
	local normal = vim.api.nvim_get_hl(0, { name = 'Normal', link = false })
	assert(normal.bg and normal.fg, 'theme must supply readable foreground and background')
	local function brightness(color)
		return bit.band(bit.rshift(color, 16), 255) * 0.299
			+ bit.band(bit.rshift(color, 8), 255) * 0.587
			+ bit.band(color, 255) * 0.114
	end
	assert((brightness(normal.bg) > brightness(normal.fg)) == (background == 'light'),
		'actual highlight colors must match the selected appearance')
end

local function focus()
	vim.api.nvim_exec_autocmds('FocusGained', {})
	vim.wait(30, function() return false end)
end

local ok, err = xpcall(function()
	local appearance = require('system-appearance')
	vim.o.background = 'dark'
	appearance.setup()
	check('light', 'github_light_default')

	result = { code = 0, stdout = 'Dark\n', stderr = '' }
	focus()
	check('dark', 'github_dark_default')

	-- The periodic probe works without terminal focus notifications.
	result = { code = 0, stdout = 'Light\n', stderr = '' }
	assert(vim.wait(3000, function() return vim.o.background == 'light' end, 10),
		'appearance must update while Neovim remains focused')
	check('light', 'github_light_default')

	-- A manual selection survives probes until the OS appearance actually changes.
	vim.cmd.colorscheme('github_dark_dimmed')
	local manual = vim.api.nvim_get_hl(0, { name = 'Normal', link = false })
	focus()
	assert(vim.g.colors_name == 'github_dark_dimmed' and vim.deep_equal(manual,
		vim.api.nvim_get_hl(0, { name = 'Normal', link = false })))
	result = { code = 0, stdout = 'Dark\n', stderr = '' }
	focus()
	check('dark', 'github_dark_default')

	for _, failure in ipairs({
		{ code = 124, stdout = '', stderr = 'timed out' },
		{ code = 1, stdout = '', stderr = 'permission denied' },
		{ code = 0, stdout = 'unexpected', stderr = '' },
	}) do
		result = failure
		focus()
		check('dark', 'github_dark_default')
	end

	-- Failed startup reads preserve the current background, then recover.
	vim.o.background = 'light'
	appearance.setup()
	check('light', 'github_light_default')
	result = { code = 0, stdout = 'Dark\n', stderr = '' }
	focus()
	check('dark', 'github_dark_default')

	-- No overlapping subprocesses or stale callbacks after setup is repeated.
	delayed = true
	result = { code = 0, stdout = 'Light\n', stderr = '' }
	local before = calls
	focus()
	focus()
	assert(calls == before + 1, 'only one probe may be in flight')
	result = { code = 0, stdout = 'Dark\n', stderr = '' }
	appearance.setup()
	callbacks[1]()
	vim.wait(30, function() return false end)
	check('dark', 'github_dark_default')
	delayed = false
	before = calls
	focus()
	assert(calls == before + 1, 'setup must not duplicate focus autocmds')

	-- Non-macOS hosts must not run defaults and should honor background changes.
	vim.fn.has = function(feature)
		return feature == 'macunix' and 0 or original_has(feature)
	end
	vim.o.background = 'light'
	before = calls
	appearance.setup()
	check('light', 'github_light_default')
	vim.o.background = 'dark'
	check('dark', 'github_dark_default')
	vim.o.background = 'light'
	check('light', 'github_light_default')
	focus()
	assert(calls == before, 'non-macOS must not invoke defaults')

	vim.api.nvim_exec_autocmds('VimLeavePre', {})
end, debug.traceback)
vim.system = original_system
vim.fn.has = original_has
if not ok then
	io.stderr:write(err .. '\n')
	vim.cmd('cquit 1')
end
print('PASS: startup, light/dark highlights, live polling, focus, failures, reloads, and non-macOS')
vim.cmd('qa!')
