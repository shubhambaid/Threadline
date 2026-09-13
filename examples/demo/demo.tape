# Records the README demo GIF with VHS (https://github.com/charmbracelet/vhs).
#
#   npm run build
#   vhs examples/demo/demo.tape
#
# The full demo output is long; trim the GIF, or raise the sleeps, to taste.

Output docs/assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 800
Set Padding 20
Set TypingSpeed 35ms

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "# One task, three agents, no shared chat history."
Enter
Sleep 1s
Type "examples/demo/run-demo.sh | less -R"
Sleep 500ms
Enter
Sleep 2s

# Scroll through setup and Codex's attempt.
Type "/== Codex"
Enter
Sleep 3s

# Claude Code's briefing, compiled only from Codex's records.
Type "/== Claude Code"
Enter
Sleep 6s

# Gemini sees Claude Code's decision and checkpoint.
Type "/== Gemini"
Enter
Sleep 6s

# What the repository now remembers.
Type "/== What the repository"
Enter
Sleep 6s

Type "q"
