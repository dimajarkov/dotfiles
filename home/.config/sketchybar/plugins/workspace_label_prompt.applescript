-- Fixed source only. Workspace IDs and labels arrive as data arguments.
on run argv
    if item 1 of argv is "error" then
        display dialog (item 2 of argv) with title "Workspace labels" buttons {"OK"} default button "OK" giving up after 30
        return "ERROR"
    end if
    set workspaceID to item 2 of argv
    set currentLabel to item 3 of argv
    set shortcutNumber to item 4 of argv
    set explanation to "Display name only; AeroSpace ID and shortcuts stay unchanged." & return & "AeroSpace ID: " & workspaceID
    if shortcutNumber is not "" then set explanation to explanation & return & "Shortcut: Option-" & shortcutNumber
    try
        set response to display dialog explanation with title "Rename workspace label" default answer currentLabel buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel" giving up after 180
        if gave up of response then return "CANCEL"
        return "SAVE" & linefeed & (text returned of response)
    on error errorMessage number errorNumber
        if errorNumber is -128 then return "CANCEL"
        error "Workspace label dialog failed" number errorNumber
    end try
end run
