# docs/media/mcp-refusal.gif — an agent's create refused by the control plane.
#
# Do not run this tape directly: it expects ROCKYSURF_URL, ROCKYSURF_TOKEN and
# ROCKYSURF_MCP_CMD to point at a control plane whose limits are about to refuse something.
# `docs/media/mcp-refusal.sh` stands one up, exports those three, and calls vhs with this file.
#
#   ./docs/media/mcp-refusal.sh
#
# Sized for a README: ~78 columns, which is what the MCP server's own startup banner needs
# in order not to wrap, and tall enough that the whole exchange is on screen at the end.

Output docs/media/mcp-refusal.gif

Require node

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 20
Set Width 1010
Set Height 840
Set Padding 20
Set BorderRadius 8
Set Framerate 12
Set TypingSpeed 55ms

# GitHub dark, so the clip sits in a README without shouting.
Set Theme { "background": "#0d1117", "foreground": "#e6edf3", "cursor": "#e6edf3", "selection": "#264f78", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

# A bare prompt: the shell's default one is noise, and the recording starts on a clean screen.
Hide
Type "PS1='$ '"
Enter
Type "clear"
Enter
Show

Sleep 1s
Type "node docs/media/mcp-refusal-demo.mjs"
Sleep 800ms
Enter

# The run itself: connect, list, three creates, and the refusal. The demo paces its own
# output, so this is only "stay recording until it has finished talking".
Sleep 18s

# A held final frame, so the refusal is still on screen when the GIF loops.
Sleep 4s
