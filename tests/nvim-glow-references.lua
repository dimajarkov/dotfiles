-- Run with: nvim --headless -u NONE -l tests/nvim-glow-references.lua
vim.opt.runtimepath:prepend('home/.config/nvim')
local references = require('glow-references')
local root = vim.fn.tempname()
vim.fn.mkdir(root .. '/docs', 'p')
vim.fn.mkdir(root .. '/.git', 'p')
local function file(name)
	vim.fn.writefile({ '# Target' }, root .. '/' .. name)
end
file('docs/source.md')
file('docs/local.md')
file('root.md')
file("docs/reader's notes.md")
file('code.lua')
local source = root .. '/docs/source.md'
local function check(text, column, lines, expected, line)
	local result = references.reference_at(text, column, lines or {}, source, root)
	assert(result and result.path == root .. '/' .. expected, vim.inspect({ text, result, expected }))
	assert(result.line == line, vim.inspect(result))
end
check('  local.md  ', 5, {}, 'docs/local.md')
check('  root.md +', 5, {}, 'root.md')
check('  code.lua:12:3 ', 8, {}, 'code.lua', 12)
check('  root.md#heading ', 8, {}, 'root.md')
check("  reader's notes.md  ", 13, { "`reader's notes.md`" }, "docs/reader's notes.md")
check('  Read this [1] ', 7, { '[Read this](local.md)' }, 'docs/local.md')
check('  root.md. ', 6, {}, 'root.md')
for _, text in ipairs({ 'missing.md', 'https://example.com/root.md', 'ordinary prose', 'root.md' }) do
	local column = text == 'root.md' and 30 or 2
	assert(not references.reference_at(text, column, {}, source, root), text)
end
assert(not references.reference_at('not-root.md', 7, { '`root.md`' }, source, root),
	'a source span must not match inside a different filename')
vim.fn.delete(root, 'rf')
print('PASS: Glow references resolve local/root paths, links, spaces and line numbers; ignore non-files')

local system, notify, executable = vim.system, vim.notify, vim.fn.executable
local env, pane = vim.env.HERDR_ENV, vim.env.HERDR_PANE_ID
local calls, warnings = {}, {}
vim.notify = function(message) warnings[#warnings + 1] = message end
vim.fn.executable = function() return 1 end
vim.system = function(argv, _, callback)
	calls[#calls + 1] = argv
	callback({ code = 0, stdout = '{"result":{"pane":{"pane_id":"owned:new"}}}' })
end
vim.env.HERDR_ENV, vim.env.HERDR_PANE_ID = nil, nil
references.open({ path = '/tmp/target.md' }, '/tmp')
assert(#calls == 0 and #warnings == 1, 'outside Herdr must warn without launching anything')
vim.env.HERDR_ENV, vim.env.HERDR_PANE_ID = '1', 'owned:source'
local target = "/tmp/reader's notes.md"
references.open({ path = target }, '/tmp')
assert(vim.wait(1000, function() return #calls == 2 end), 'split and run did not finish')
assert(vim.deep_equal(calls[1], {
	'herdr', 'pane', 'split', '--current', '--direction', 'right', '--cwd', '/tmp', '--focus',
}), vim.inspect(calls))
assert(calls[2][4] == 'owned:new', 'must run in the returned pane, never the focused pane')
assert(calls[2][5] == table.concat(vim.tbl_map(vim.fn.shellescape, {
	vim.v.progpath, '+Glow', '--', target,
}), ' '), vim.inspect(calls[2]))
calls = {}
vim.system = function(_, _, callback) callback({ code = 0, stdout = '42' }) end
references.open({ path = target }, '/tmp')
assert(vim.wait(1000, function() return #warnings == 2 end), 'invalid split reply must warn')
assert(#calls == 0, 'invalid split reply must not launch an editor')
vim.system, vim.notify, vim.fn.executable = system, notify, executable
vim.env.HERDR_ENV, vim.env.HERDR_PANE_ID = env, pane
print('PASS: Herdr guard, caller-bound right split, returned pane ID, safe quoting and malformed replies')
