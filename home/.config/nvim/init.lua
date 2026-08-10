-- Set <space> as leader (must happen before other plugins loaded)
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- Relative line numbers
vim.o.relativenumber = true
vim.o.number = true -- display absolute line number instead of 0

-- Case-insensitive searching unless we use capital letters
vim.o.ignorecase = true
vim.o.smartcase = true

-- Sync vim and system clipboards
vim.schedule(function()
	local is_ssh = vim.env.SSH_TTY or vim.env.SSH_CONNECTION

	if is_ssh then
		vim.g.clipboard = "osc52"
		vim.opt.clipboard = ""
	else
		vim.g.clipboard = nil
		vim.opt.clipboard = "unnamedplus"
	end
end)

-- Copy to clipboard shortcuts
vim.keymap.set('n', '<leader>cp', function()
	local path = vim.fn.expand('%:p')
	vim.fn.setreg('+', path)
	vim.notify('Copied: ' .. path)
end, { desc = 'Copy absolute path' })

vim.keymap.set('n', '<leader>cr', function()
	local path = vim.fn.expand('%')
	vim.fn.setreg('+', path)
	vim.notify('Copied: ' .. path)
end, { desc = 'Copy relative path' })

-- Raise dialog if you close unsaved buffer (prevent mistakes)
vim.o.confirm = true

-- Disable swap files to prevent annoying errors
vim.opt.swapfile = false

-- Snappy escape
vim.o.ttimeoutlen = 1

-- Match macOS Option-Delete behavior while editing text or commands
vim.keymap.set({ 'i', 'c' }, '<M-BS>', '<C-W>', { desc = 'Delete previous word' })

-- Vim diagnostics
vim.diagnostic.config({
	underline = false,       -- don't underline errors
	severity_sort = true,    -- show most severe error first
	update_in_insert = false, -- don't update while typing
	float = { source = 'if_many' }, -- nicer look for floats and show source if multiple sources (ex. ruff and ty)
	jump = { float = true }, -- automatically open the diagnostic float if you jump with [d ]d
})

-- Show diagnostics
vim.keymap.set('n', '<leader>D', vim.diagnostic.open_float, { desc = 'Show diagnostics' })

-- Easily move between windows
vim.keymap.set('n', '<C-h>', '<C-w><C-h>', { desc = 'Move focus to the left window' })
vim.keymap.set('n', '<C-l>', '<C-w><C-l>', { desc = 'Move focus to the right window' })
vim.keymap.set('n', '<C-j>', '<C-w><C-j>', { desc = 'Move focus to the lower window' })
vim.keymap.set('n', '<C-k>', '<C-w><C-k>', { desc = 'Move focus to the upper window' })

-- Better command line movements
vim.keymap.set("c", "<C-b>", "<Left>")
vim.keymap.set("c", "<C-f>", "<Right>")
vim.keymap.set("c", "<C-a>", "<Home>")
vim.keymap.set("c", "<C-e>", "<End>")
vim.keymap.set("c", "<M-b>", "<S-Left>")
vim.keymap.set("c", "<M-f>", "<S-Right>")

-- Highlight yanks
vim.api.nvim_create_autocmd('TextYankPost', {
	group = vim.api.nvim_create_augroup('highlight-yank', { clear = true }),
	callback = function() vim.highlight.on_yank({ timeout = 300 }) end,
})

-- Plugins
-- Pack guide: https://echasnovski.com/blog/2026-03-13-a-guide-to-vim-pack#update
vim.pack.add({
	'https://github.com/ibhagwan/fzf-lua',
	'https://github.com/nvim-treesitter/nvim-treesitter', -- also $ brew install tree-sitter-cli
	'https://github.com/neovim/nvim-lspconfig',
	'https://github.com/karb94/neoscroll.nvim',
	'https://github.com/mfussenegger/nvim-dap',
	'https://github.com/stevearc/oil.nvim',
	'https://github.com/esmuellert/codediff.nvim',
	'https://github.com/goolord/alpha-nvim',
	'https://github.com/MeanderingProgrammer/render-markdown.nvim',
	'https://github.com/nvim-mini/mini.nvim',
	'https://github.com/folke/which-key.nvim',
	{ src = 'https://github.com/saghen/blink.cmp', version = vim.version.range('1.x') }, -- pinning so rust binary dependency automatically downloads
	-- Colorschemes
	'https://github.com/rebelot/kanagawa.nvim',
	{ src = "https://github.com/rose-pine/neovim", name = "rose-pine" },
	'https://github.com/vague-theme/vague.nvim',
	'https://github.com/vossenwout/guts.nvim',
})

-- Mini.nvim
require('mini.ai').setup()
require('mini.icons').setup()

-- Keybinding guide
require('which-key').setup({
	preset = 'modern',
	spec = {
		{ '<leader>c', group = 'clipboard' },
		{ '<leader>d', group = 'debug / diagnostics' },
		{ '<leader>f', group = 'find' },
		{ '<leader>g', group = 'git' },
		{ '<leader>r', group = 'review' },
	},
})

-- Vague Colorscheme
vim.pack.add({ 'https://github.com/vague-theme/vague.nvim' })
-- Kanagawa Colorscheme
require('kanagawa').setup({
	colors = {
		theme = {
			all = {
				ui = {
					bg_gutter = "none"
				}
			}
		}
	}
})
-- vim.cmd('colorscheme kanagawa-wave')
-- Guts Colorscheme
vim.cmd.colorscheme("guts")

-- Rose pine Colorscheme
require("rose-pine").setup()
--vim.cmd.colorscheme("rose-pine")

-- Markdown
require('render-markdown').setup({})

-- FzfLua Setup
local fzf = require('fzf-lua')
fzf.setup({
	fzf_colors = false,
	grep = {
		rg_opts = table.concat({
			"--column --line-number --no-heading --color=always --smart-case --max-columns=4096",
			"--colors 'path:none'",
			"--colors 'line:none'",
			"--colors 'column:none'",
			"--colors 'match:fg:225,255,229'",
			"-e",
		}, " "),
	},
	ui_select = true,
	keymap = {
		builtin = {
			["<C-d>"] = 'preview-page-down', -- Better scrolling within the displays
			["<C-u>"] = 'preview-page-up',
		},
	},
	winopts = {
		height  = 0.95, -- window height
		width   = 0.90, -- window width
		preview = {
			layout   = 'vertical',
			vertical = "down:30%",
		}
	},
	files = {
		formatter = 'path.filename_first',
	},
})

vim.keymap.set('n', '<leader><leader>', '<cmd>FzfLua files<cr>', { desc = 'Find files' })
vim.keymap.set('n', '<leader>/', '<cmd>FzfLua live_grep<cr>', { desc = 'Find live grep' })
vim.keymap.set('n', '<leader>fr', '<cmd>FzfLua resume<cr>', { desc = 'Resume last picker' })
vim.keymap.set('n', '<leader>,', '<cmd>FzfLua buffers<cr>', { desc = 'Buffers' })

vim.keymap.set('n', 'grr', fzf.lsp_references, { desc = 'References' })
vim.keymap.set('n', 'gri', fzf.lsp_implementations, { desc = 'Implementations' })
vim.keymap.set('n', 'gra', fzf.lsp_code_actions, { desc = 'Code actions' })
vim.keymap.set('n', 'gd', fzf.lsp_definitions, { desc = 'Go to definition' })

vim.keymap.set('n', '<leader>fc', '<cmd>FzfLua colorschemes<cr>', { desc = 'Pick colorscheme' })

-- Treesitter
vim.cmd('syntax off') -- Make it obvious if treesitter is missing
vim.api.nvim_create_autocmd('FileType', {
	callback = function() pcall(vim.treesitter.start) end,
})

-- LSP
vim.lsp.enable({
	'ty',            -- also $ uv tool install ty@latest
	'ruff',          -- also $ uv tool install ruff@latest
	'lua_ls'         -- also $ brew install lua-language-server
})
vim.o.signcolumn = 'yes' -- make lsp warnings not widen the gutter
-- Auto-format ("lint") on save (adapted from neovim docs :help auto-format)
vim.api.nvim_create_autocmd('LspAttach', {
	group = vim.api.nvim_create_augroup('my.lsp', { clear = true }),
	callback = function(ev)
		local client = assert(vim.lsp.get_client_by_id(ev.data.client_id))
		if not client:supports_method('textDocument/willSaveWaitUntil')
		    and client:supports_method('textDocument/formatting') then
			vim.api.nvim_create_autocmd('BufWritePre', {
				group = vim.api.nvim_create_augroup('my.lsp.fmt', { clear = false }),
				buffer = ev.buf,
				callback = function()
					vim.lsp.buf.format({ bufnr = ev.buf, id = client.id, timeout_ms = 1000 })
				end,
			})
		end
	end,
})
-- Blink.cmp
require('blink.cmp').setup({
	signature = {
		enabled = true,
		window = { show_documentation = false },
	},
})

-- Neoscroll
require('neoscroll').setup({
	hide_cursor = false,
	stop_eof = true,
	easing = 'quadratic',
	duration_multiplier = 0.30,
})

-- Dap (debugging)
local dap = require('dap')
dap.adapters.debugpy = function(cb, config) -- also $ uv tool install debugpy@latest
	if config.request == 'attach' then
		cb({
			type = 'server',
			port = config.connect.port,
			host = config.connect.host or '127.0.0.1',
		})
	else
		cb({
			type = 'executable',
			command = 'debugpy-adapter',
		})
	end
end
dap.configurations.python = { -- https://github.com/microsoft/debugpy/wiki/Debug-configuration-settings
	{
		type = 'debugpy',
		request = 'launch',
		name = 'Launch file',
		program = '${file}',
		justMyCode = false,
		python = function()
			local root = vim.fs.root(0, '.venv')
			return { root and root .. '/.venv/bin/python' or 'python3' }
		end,
		cwd = function()
			return vim.fs.root(0, '.venv') or vim.fn.getcwd()
		end,
	},
	{
		type = 'debugpy',
		request = 'launch',
		name = 'Pytest current file',
		module = 'pytest',
		args = { '${file}', '-s' },
		justMyCode = false,
		python = function()
			local root = vim.fs.root(0, '.venv')
			return { root and root .. '/.venv/bin/python' or 'python3' }
		end,
		cwd = function()
			return vim.fs.root(0, '.venv') or vim.fn.getcwd()
		end,
	},
	{
		type = 'debugpy',
		request = 'launch',
		name = 'Pytest current file -k',
		module = 'pytest',
		args = function()
			local test_name = vim.fn.input('pytest -k: ')
			return { '${file}', '-s', '-k', test_name }
		end,
		justMyCode = false,
		python = function()
			local root = vim.fs.root(0, '.venv')
			return { root and root .. '/.venv/bin/python' or 'python3' }
		end,
		cwd = function()
			return vim.fs.root(0, '.venv') or vim.fn.getcwd()
		end,
	},
}
vim.keymap.set('n', '<leader>db', dap.toggle_breakpoint, { desc = 'Debug toggle breakpoint' })
vim.keymap.set('n', '<leader>dc', dap.continue, { desc = 'Debug continue' })
vim.keymap.set('n', '<leader>dq', dap.terminate, { desc = 'Debug terminate' })
vim.keymap.set('n', '<leader>dr', dap.repl.open, { desc = 'Debug open REPL' })
vim.keymap.set('n', '<leader>dl', dap.run_last, { desc = 'Debug run last' })
vim.keymap.set({ 'n', 'v' }, '<leader>dh', require('dap.ui.widgets').hover, { desc = 'Debug hover' })
vim.keymap.set('n', '<Down>', dap.step_over, { desc = 'Debug step over' })
vim.keymap.set('n', '<Right>', dap.step_into, { desc = 'Debug step into' })
vim.keymap.set('n', '<Left>', dap.step_out, { desc = 'Debug step out' })
vim.keymap.set('n', '<Up>', dap.restart_frame, { desc = 'Debug restart frame' })

-- Oil.nvim
require("oil").setup({
	keymaps = {
		["<C-h>"] = "<C-w>h",
		["<BS>"] = "<C-w>h", -- only if your terminal sends Ctrl-h as BS
		["<C-l>"] = "<C-w>l",
		["<C-j>"] = "<C-w>j",
		["<C-k>"] = "<C-w>k",
		["Y"] = {
			function()
				local oil = require("oil")
				local entry = oil.get_cursor_entry()
				local dir = oil.get_current_dir()

				if not entry or not dir then
					return
				end

				local path = dir .. entry.name
				vim.fn.setreg("+", path)
				vim.fn.setreg("\"", path)
				vim.notify("Copied " .. path)
			end,
			desc = "Copy full path",
		},
	},
	columns = {
		"icon",
		{ "mtime", highlight = "Comment" },
	},
	view_options = {
		show_hidden = true,
		sort = {
			{ "type",  "asc" },
			{ "mtime", "desc" },
		}
	},
})
vim.keymap.set("n", "-", "<CMD>Oil<CR>", { desc = "Open parent directory" })

-- Hunk
local function git_root_from_dir(dir)
	if not dir or dir == '' then
		return nil
	end

	local result = vim.fn.systemlist({ 'git', '-C', dir, 'rev-parse', '--show-toplevel' })
	if vim.v.shell_error == 0 and result[1] and result[1] ~= '' then
		return result[1]
	end

	return nil
end

local function hunk_root()
	local candidates = {}
	local buffer_name = vim.api.nvim_buf_get_name(0)

	if buffer_name ~= '' then
		local buffer_path = buffer_name
		if buffer_name:match('^oil://') then
			buffer_path = buffer_name:gsub('^oil://', '')
		elseif buffer_name:match('^%w+://') then
			buffer_path = nil
		end

		if buffer_path then
			buffer_path = vim.fn.fnamemodify(buffer_path, ':p')
			local buffer_dir = vim.fn.isdirectory(buffer_path) == 1 and buffer_path or vim.fn.fnamemodify(buffer_path, ':h')
			table.insert(candidates, buffer_dir)
		end
	end

	table.insert(candidates, vim.fn.getcwd())

	for _, dir in ipairs(candidates) do
		local root = git_root_from_dir(dir)
		if root then
			return root
		end
	end

	return nil
end

local function open_hunk(args, cwd)
	if vim.fn.executable('hunk') ~= 1 then
		vim.notify('hunk is not installed. Install it with: npm i -g hunkdiff', vim.log.levels.ERROR)
		return
	end

	local hunk_args = vim.list_extend({ 'hunk' }, args)
	cwd = cwd or vim.fn.getcwd()

	vim.cmd('tabnew')
	vim.bo.buflisted = false
	vim.bo.bufhidden = 'wipe'
	pcall(vim.api.nvim_buf_set_name, 0, 'Hunk://' .. vim.fn.fnamemodify(cwd, ':t') .. '/' .. vim.fn.localtime())

	local job_id = vim.fn.jobstart(hunk_args, { cwd = cwd, term = true })
	if job_id <= 0 then
		vim.notify('Failed to start hunk', vim.log.levels.ERROR)
		vim.cmd('tabclose')
		return
	end

	vim.cmd('startinsert')
end

vim.api.nvim_create_user_command('Hunk', function(opts)
	local args = opts.fargs
	local cwd = hunk_root()

	if #args == 0 then
		if not cwd then
			vim.notify('Hunk needs a Git repo. Open Nvim from a checkout, :cd to one, or edit a file inside one.', vim.log.levels.ERROR)
			return
		end

		args = { 'diff', '--watch' }
	end

	open_hunk(args, cwd)
end, {
	nargs = '*',
	complete = function()
		return { 'diff', 'show', 'patch', 'skill' }
	end,
	desc = 'Open Hunk',
})

local function git_line_history(start_line, end_line)
	start_line, end_line = math.min(start_line, end_line), math.max(start_line, end_line)
	local range = start_line .. ',' .. end_line .. ':' .. vim.fn.expand('%:t')
	local command = { 'git', '-C', vim.fn.expand('%:p:h'), '--no-pager', 'log', '-L', range }
	local output = vim.fn.systemlist(command)
	local command_text = vim.fn.join(vim.tbl_map(vim.fn.shellescape, command), ' ')

	vim.cmd('vnew')
	vim.bo.buftype = 'nofile'
	vim.bo.filetype = 'diff'
	vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.list_extend({ command_text, '' }, output))
	vim.bo.modified = false
end

vim.keymap.set('n', '<leader>gg', '<cmd>Hunk<cr>', { desc = 'Hunk diff' })
vim.keymap.set('n', '<leader>gb', function() vim.ui.open(vim.fn.systemlist('git remote get-url origin')[1]) end,
	{ desc = 'Open git remote' })
vim.keymap.set('n', '<leader>gl', function()
	git_line_history(vim.fn.line('.'), vim.fn.line('.'))
end, { desc = 'Git line history' })
vim.keymap.set('v', '<leader>gl', function()
	git_line_history(vim.fn.line('v'), vim.fn.line('.'))
end, { desc = 'Git line history' })

-- Codediff (vscode like diffs :))
require("codediff").setup({})
vim.keymap.set('n', '<leader>ru', '<cmd>CodeDiff<cr>', { desc = 'Code diff not staged' })
vim.keymap.set('n', '<leader>rm', '<cmd>CodeDiff main<cr>', { desc = 'Code diff main' })
vim.keymap.set('n', '<leader>rh', '<cmd>CodeDiff HEAD~1<cr>', { desc = 'Code diff previous commit' })

-- Compatibility shortcuts from the previous local setup.
vim.keymap.set('n', '<leader>o', '<cmd>Oil<cr>', { desc = 'Open file browser' })
vim.keymap.set('n', '<leader>f', '<cmd>FzfLua files<cr>', { desc = 'Find files' })
vim.keymap.set('n', '<leader>b', '<cmd>FzfLua buffers<cr>', { desc = 'Buffers' })
vim.keymap.set('n', '<leader>g', '<cmd>Hunk<cr>', { desc = 'Hunk diff' })
vim.keymap.set('n', '<leader>d', vim.diagnostic.open_float, { desc = 'Show diagnostics' })

-- Home-row horizontal movement from the previous local setup.
vim.keymap.set({ 'n', 'v' }, 'l', 'h', {})
vim.keymap.set({ 'n', 'v' }, ';', 'l', {})

-- Start screen
local alpha = require('alpha')
local dashboard = require('alpha.themes.dashboard')
dashboard.section.header.val = vim.split(
	[[
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⣴⢋⣔⣶⣿⢋⣙⣳⣤⣀⣠⣤⠐⠄⠀⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠰⣿⡾⣿⣿⣿⣿⣿⣿⣿⣬⣥⣤⣠⡦⠖⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⣿⣿⣿⣿⣿⣿⣿⣿⡟⠛⠆⢀⠀⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣤⣄⣠⣤⣄⠄⡀⢠⣯⣿⣿⣿⣿⣿⣿⣾⣷⣤⢔⣊⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣾⣿⣿⣿⣿⣿⣿⣿⣾⣽⣧⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣭⡟⠊⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠀⠀⢀⣤⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡗⠀⠻⢿⣿⣉⠛⢻⣿⠉⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠸⠀⠀⣼⢯⣿⣿⣿⣿⣿⣿⣿⣿⣻⣿⣿⣿⢿⣿⣷⠠⢠⢏⣿⠉⠉⠩⠛⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢀⠄⠀⠓⣶⣯⣿⣿⣿⣿⣟⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⣇⣚⡁⠀⠁⢠⠀⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠈⠃⡀⠀⣿⣿⣿⣿⣿⣟⣿⣯⣷⣻⣽⣿⣯⣟⢻⣻⣿⣿⣿⣷⢶⠞⢗⣲⣄⡤⡂⠉⠀⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⣹⠛⠏⢳⡀⠹⣿⣿⣿⣿⣿⣿⣿⣯⣤⣝⣿⣿⣿⣿⣿⣶⣷⣟⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⣦⡿⠋⣗⠤⢹⡜⢛⠻⣿⣿⣷⣾⣿⣯⣧⡽⣿⣿⣿⣿⣷⣍⢳⢥⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡗⠍⣅⣴⣿⣄⡘⠆⠈⠨⡌⢻⣿⡗⣬⣼⢟⣫⡾⢿⣿⣿⣿⣿⡿⡄⢮⣆⠀⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⢠⠦⢀⡀⠀⠀⠀⢇⢸⡭⠓⠁⠁⠜⠈⠄⠀⠱⡀⢻⣿⣾⡤⢼⣿⣖⣿⣿⣿⣿⣿⣷⡆⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⢀⣔⣋⣥⢋⢹⡀⠀⠀⢰⢸⢀⢴⣀⣤⠦⠀⠨⠃⠀⠒⢮⣿⣵⣧⣸⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄⠀⠀⠀⠀⠀⡄⠄⠀⠀⠀⠀⠀⠀⠀
⠀⣀⡆⡎⡀⠀⠀⠀⠀⠀⠀⠰⠀⠸⠀⠷⣶⣆⣶⡆⠀⠀⣀⣿⡿⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀⠀⠀⠀⣰⠆⢀⡀⠆⠀⠀⠀⠀
⠀⢕⣿⢀⣱⠪⢧⢻⠇⢀⠀⠀⠀⠀⠀⠀⠙⠯⡄⣙⣧⢤⣷⠿⣿⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄⠀⠀⠛⣴⣵⡿⣣⢨⠄⠀⠀
⢰⡆⡜⡎⠁⠀⢰⠒⣾⢠⡄⠀⠀⠀⠀⠀⠀⠀⠸⢿⣿⠿⠁⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⢦⣗⣈⢻⣄⡟⠅⣀⢠⡄
⠀⢿⠀⠐⢠⣆⠲⡶⡗⠱⡇⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠩⣽⣿⣿⡳⣿⢴⡿⠅
⢰⢘⠀⢻⡄⢧⠸⣗⡧⢄⣾⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⢠⣟⣾⡇⢹⠓⠀⠀
⠈⡈⡀⠀⠁⡈⠚⣿⣉⣓⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⠾⠃⣯⠀⡀⠀
⠀⢳⣤⡀⠀⢰⠀⠻⣿⡿⠀⠀⠀⠀⠀⠀⠀⢀⠀⢠⠎⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣳⠆⢱⡇⠘⣄
⠀⠈⠿⠹⠆⢀⡆⠈⠁⡇⠀⠀⠀⠀⠀⠀⡞⠃⣿⡏⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠻⢠⠀⡇⡀⢚
⠀⠀⠀⣼⠀⠸⠅⠀⠀⢺⠀⠀⠀⠀⠀⣼⡷⢋⣼⢷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⢾⣧⢰⠃⢠
⠀⠀⢀⠫⠀⣆⠀⠀⠀⢚⠄⠀⠀⠀⠀⠛⣠⠋⢸⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⣻⡆⠘⠄⠈
⠀⠀⢀⡀⠇⠀⠀⡀⠀⣿⡸⣤⣤⣀⠀⢸⣧⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣻⣇⢠⠀⡀
⠀⠀⣸⡇⢠⠀⠀⢠⠃⠘⣽⣿⣿⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡗⢙⣮⠂⠀⠀
⠀⢰⣿⣿⣈⠀⠀⠠⠷⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠲⠄⢃⠀⠀
⠀⠘⣿⣿⣿⡄⠀⠀⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⠁⠀⠀⠀⠀
⠀⠀⣿⣿⣿⣧⣰⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⢂⠂⡀⠀⠀⠀
        ]], '\n', { trimempty = true })
dashboard.section.header.opts.hl = 'Comment'
dashboard.section.buttons.val = {}
dashboard.section.footer.val = 'PookieVim v3000'
dashboard.section.footer.opts.hl = 'Comment'
alpha.setup(dashboard.opts)
