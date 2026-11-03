-- Local file navigation for the real Glow terminal, without replacing its renderer.
local M = {}

local function resolve(reference, source, cwd)
	if reference:match('^%a[%w+.-]*://') then return nil end
	local path, line = reference:match('^(.-):(%d+):?%d*$')
	path = (path or reference):gsub('#.*$', '')
	if path == '' then return nil end
	local bases = { vim.fs.dirname(source) }
	local root = vim.fs.root(source, '.git')
	if root then bases[#bases + 1] = root end
	bases[#bases + 1] = cwd
	for _, base in ipairs(bases) do
		local candidate = path
		if candidate:sub(1, 2) == '~/' then
			candidate = vim.env.HOME .. candidate:sub(2)
		elseif candidate:sub(1, 1) ~= '/' then
			candidate = base .. '/' .. candidate
		end
		candidate = vim.fs.normalize(candidate)
		if vim.fn.filereadable(candidate) == 1 then
			return { path = candidate, line = tonumber(line) }
		end
	end
end

-- Source spans also support filenames containing spaces and Markdown link labels.
local function source_reference(text, column, source_lines, source, cwd)
	for _, line in ipairs(source_lines) do
		local spans = {}
		for label, target in line:gmatch('%[([^%]]+)%]%(([^%)]+)%)') do
			target = target:match('^<([^>]+)>') or target:match('^(%S+)')
			spans[#spans + 1] = { label, target }
		end
		for code in line:gmatch('`([^`]+)`') do spans[#spans + 1] = { code, code } end
		for _, span in ipairs(spans) do
			local start = 1
			while true do
				local first, last = text:find(span[1], start, true)
				if not first then break end
				local before, after = text:sub(first - 1, first - 1), text:sub(last + 1, last + 1)
				local boundary = '[%s`<>%[%]%(%)"|,;]'
				if column >= first and column <= last
					and (first == 1 or before:match(boundary))
					and (last == #text or after:match(boundary)) then
					local target = resolve(span[2], source, cwd)
					if target then return target end
				end
				start = last + 1
			end
		end
	end
end

function M.reference_at(text, column, source_lines, source, cwd)
	local target = source_reference(text, column, source_lines, source, cwd)
	if target then return target end
	for first, word, last in text:gmatch('()([^%s`<>%[%]%(%)"|,;]+)()') do
		if column >= first and column < last then
			return resolve(word, source, cwd) or resolve(word:gsub('[.!?]+$', ''), source, cwd)
		end
	end
end

local function warn(message)
	vim.notify(message, vim.log.levels.WARN)
end

function M.open(target, cwd)
	if vim.env.HERDR_ENV ~= '1' or not vim.env.HERDR_PANE_ID or vim.fn.executable('herdr') ~= 1 then
		warn('Glow file navigation requires a Herdr pane')
		return
	end
	-- Only our own pane is targeted, never whichever pane another client focused.
	vim.system({ 'herdr', 'pane', 'split', '--current', '--direction', 'right', '--cwd', cwd, '--focus' },
		{ text = true }, vim.schedule_wrap(function(result)
			if result.code ~= 0 then
				warn('Could not split Herdr pane: ' .. (result.stderr or ''))
				return
			end
			local ok, response = pcall(vim.json.decode, result.stdout)
			local pane = ok and type(response) == 'table' and type(response.result) == 'table' and response.result.pane
			if type(pane) ~= 'table' or type(pane.pane_id) ~= 'string' then
				warn('Herdr did not return the new pane ID')
				return
			end
			local command = { vim.v.progpath }
			local extension = (vim.fn.fnamemodify(target.path, ':e')):lower()
			if vim.tbl_contains({ 'md', 'markdown', 'mdown', 'mkd' }, extension) then
				command[#command + 1] = '+Glow'
			elseif target.line then
				command[#command + 1] = '+' .. target.line
			end
			command[#command + 1] = '--'
			command[#command + 1] = target.path
			command = vim.tbl_map(vim.fn.shellescape, command)
			vim.system({ 'herdr', 'pane', 'run', pane.pane_id, table.concat(command, ' ') },
				{ text = true }, vim.schedule_wrap(function(run)
					if run.code ~= 0 then warn('Could not start Neovim: ' .. (run.stderr or '')) end
				end))
		end))
end

function M.attach(preview, source)
	local path = vim.api.nvim_buf_get_name(source)
	local lines = vim.api.nvim_buf_get_lines(source, 0, -1, false)
	local cwd = vim.fn.getcwd()
	vim.keymap.set({ 't', 'n' }, '<LeftMouse>', function()
		local mouse = vim.fn.getmousepos()
		if mouse.winid == 0 or vim.api.nvim_win_get_buf(mouse.winid) ~= preview or mouse.line < 1 then return end
		local text = vim.api.nvim_buf_get_lines(preview, mouse.line - 1, mouse.line, false)[1] or ''
		local target = M.reference_at(text, mouse.column, lines, path, cwd)
		if not target then
			-- Glow can wrap a long code-styled path over several terminal rows.
			-- Reassemble its paragraph, but only accept references present in the
			-- source, not arbitrary paths manufactured by joining unrelated rows.
			local paragraph = vim.api.nvim_buf_get_lines(preview, math.max(0, mouse.line - 32), mouse.line + 32, false)
			local index = math.min(mouse.line, 32)
			local first, last = index, index
			while first > 1 and paragraph[first - 1]:match('%S') do first = first - 1 end
			while last < #paragraph and paragraph[last + 1]:match('%S') do last = last + 1 end
			local joined, column = {}, mouse.column - #(text:match('^%s*') or '')
			for row = first, last do
				local fragment = vim.trim(paragraph[row])
				joined[#joined + 1] = fragment
				if row < index then column = column + #fragment end
			end
			target = source_reference(table.concat(joined), column, lines, path, cwd)
		end
		if target then M.open(target, cwd) end
	end, { buffer = preview, desc = 'Open Glow file reference in a right-hand Herdr pane' })
end

return M
