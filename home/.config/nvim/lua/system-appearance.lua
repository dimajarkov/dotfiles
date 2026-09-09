local M = {}
local stop = function() end

local function decode(result)
	if result.code == 0 then
		local value = vim.trim(result.stdout or '')
		if value == 'Dark' then return 'dark' end
		if value == 'Light' then return 'light' end
	elseif result.code == 1 and (result.stderr or ''):find(
		'(kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist', 1, true
	) then
		-- macOS represents light mode by omitting AppleInterfaceStyle.
		return 'light'
	end
	-- Timeouts and other failures must not flip an already-correct theme.
end

local function probe(callback)
	return pcall(vim.system, { '/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle' },
		{ text = true, timeout = 1000 }, callback)
end

function M.setup()
	stop()
	local group = vim.api.nvim_create_augroup('system-appearance', { clear = true })
	local active, applying = true, false
	local timer, pending, last_appearance

	local function apply(appearance)
		if not active or applying or not appearance or appearance == last_appearance then return end
		applying = true
		last_appearance = appearance
		vim.o.background = appearance
		vim.cmd.colorscheme(appearance == 'light' and 'rose-pine-dawn' or 'guts')
		applying = false
	end

	stop = function()
		active = false
		if timer then
			timer:stop()
			timer:close()
		end
		if pending then pending:kill(15) end
	end
	vim.api.nvim_create_autocmd('VimLeavePre', { group = group, callback = function() stop() end })

	if vim.fn.has('macunix') ~= 1 then
		apply(vim.o.background)
		vim.api.nvim_create_autocmd('OptionSet', {
			group = group,
			pattern = 'background',
			callback = function() apply(vim.o.background) end,
		})
		return
	end

	-- Resolve the initial palette before drawing the UI. Bound the startup read.
	local ok, process = probe()
	apply((ok and decode(process:wait())) or vim.o.background)

	local function refresh()
		if not active or pending then return end
		local started, job = probe(function(result)
			vim.schedule(function()
				if not active then return end
				pending = nil
				apply(decode(result))
			end)
		end)
		if started then pending = job end
	end

	vim.api.nvim_create_autocmd('FocusGained', { group = group, callback = refresh })
	-- Poll asynchronously too: focus events are not forwarded by every terminal.
	timer = assert(vim.uv.new_timer())
	timer:start(2000, 2000, vim.schedule_wrap(refresh))
end

return M
