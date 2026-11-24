local M = {}
local api, fn = vim.api, vim.fn
local width = fn.strdisplaywidth
local left_edge, right_edge = '', ''

local function colors(name)
	local hl = api.nvim_get_hl(0, { name = name, link = false, create = false })
	if hl.reverse then return hl.bg, hl.fg end
	return hl.fg, hl.bg
end

local function highlights()
	local light = vim.o.background == 'light'
	local normal_fg, normal_bg = colors('Normal')
	local _, fill_bg = colors('TabLineFill')
	fill_bg = fill_bg or normal_bg
	local inactive_fg, inactive_bg = colors('TabLine')
	if not inactive_bg or inactive_bg == fill_bg then
		inactive_fg = normal_fg
		inactive_bg = light and 0xeaeef2 or 0x21262d
	end
	local active_bg = light and 0xffd33d or 0xe3b341
	api.nvim_set_hl(0, 'DotfilesTabActive', { fg = 0x161b22, bg = active_bg, bold = true })
	api.nvim_set_hl(0, 'DotfilesTabInactive', {
		fg = inactive_fg or normal_fg or (light and 0x24292f or 0xc9d1d9),
		bg = inactive_bg,
	})
	api.nvim_set_hl(0, 'DotfilesTabActiveEdge', { fg = active_bg, bg = fill_bg })
	api.nvim_set_hl(0, 'DotfilesTabInactiveEdge', { fg = inactive_bg, bg = fill_bg })
	api.nvim_set_hl(0, 'DotfilesTabFill', { bg = fill_bg })
end

local function clip(text, limit, keep_end)
	if width(text) <= limit then return text end
	local ellipsis = '…'
	local budget = limit - width(ellipsis)
	if budget < 0 then return '' end
	local count = fn.strchars(text, true)
	local low, high = 0, math.min(count, budget)
	while low < high do
		local middle = math.floor((low + high + 1) / 2)
		local part = fn.strcharpart(text, keep_end and count - middle or 0, middle, true)
		if width(part) <= budget then low = middle else high = middle - 1 end
	end
	local part = fn.strcharpart(text, keep_end and count - low or 0, low, true)
	return keep_end and ellipsis .. part or part .. ellipsis
end

local function label(tab)
	local buf = api.nvim_win_get_buf(api.nvim_tabpage_get_win(tab))
	local name = api.nvim_buf_get_name(buf)
	local options = vim.bo[buf]
	local icon = ''
	local oil = options.filetype == 'oil'
	if options.buftype == 'terminal' then
		name = '[Terminal]'
	elseif oil then
		name = fn.fnamemodify(name:gsub('^oil://', ''), ':~')
	elseif name == '' then
		name = '[No Name]'
	else
		name = fn.fnamemodify(name, ':t')
		icon = MiniIcons.get('file', name) .. ' '
	end
	name = fn.strtrans(name)
	if width(name) > 20 then name = clip(name, 18, oil) end
	return (options.modified and '[+] ' or '') .. icon .. name
end

local function format_tab(index, text, active, shaped)
	local hl = active and 'DotfilesTabActive' or 'DotfilesTabInactive'
	local body = '%#' .. hl .. '#' .. text:gsub('%%', '%%%%')
	if shaped then
		local edge = '%#' .. hl .. 'Edge#'
		body = edge .. left_edge .. body .. edge .. right_edge
	end
	return '%' .. index .. 'T' .. body .. '%T'
end

function M.render()
	local tabs = api.nvim_list_tabpages()
	local active = fn.tabpagenr()
	local remaining = vim.o.columns
	local edges = width(left_edge .. right_edge)
	local padding = '   '
	local text = label(tabs[active])
	local shaped = remaining > edges
	local cost = width(text) + edges + 2 * #padding
	if cost <= remaining then
		text = padding .. text .. padding
	else
		text = clip(text, remaining - (shaped and edges or 0), false)
		cost = width(text) + (shaped and edges or 0)
	end
	local parts = { [active] = format_tab(active, text, true, shaped) }
	remaining = remaining - cost

	-- Reserve room for the active page first, then fit whole neighboring tabs.
	local first, last = active, active
	local function add(index)
		if not tabs[index] or remaining <= edges + 2 * #padding then return false end
		local title = padding .. label(tabs[index]) .. padding
		local cells = width(title) + edges
		if cells > remaining then return false end
		parts[index] = format_tab(index, title, false, true)
		remaining = remaining - cells
		return true
	end
	local previous, following = true, true
	while previous or following do
		if previous then
			previous = add(first - 1)
			if previous then first = first - 1 end
		end
		if following then
			following = add(last + 1)
			if following then last = last + 1 end
		end
	end
	return table.concat(parts, '', first, last) .. '%#DotfilesTabFill#'
end

function M.setup()
	highlights()
	api.nvim_create_autocmd('ColorScheme', {
		group = api.nvim_create_augroup('dotfiles-tabline', { clear = true }),
		callback = highlights,
	})
	vim.o.showtabline = 1
	vim.o.tabline = "%!v:lua.require('tabline').render()"
end

return M
