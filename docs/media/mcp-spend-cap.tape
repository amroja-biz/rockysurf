# docs/media/mcp-spend-cap.gif — an agent's create refused by the monthly spend cap.
#
# Do not run this tape directly. `docs/media/mcp-refusal.sh` stands up a throwaway control
# plane with a cap in force, seeds a fleet so the cap is crossed in minutes rather than weeks,
# exports what the demo needs, and calls vhs with this file:
#
#   ROCKYSURF_DEMO_SPEND_CAP=0.01 ./docs/media/mcp-refusal.sh
#
# THE ONE EDITED THING IN THIS CLIP IS THE WAITING. The cap is crossed by core's uptime ticker
# on real wall clock — a bit over two minutes here — and a README GIF cannot sit through it. So
# recording stops at `Hide` while the fleet keeps billing and the demo keeps polling, and picks
# up again at `Show` once the ticker has crossed. Nothing is re-ordered and nothing is staged:
# the elapsed time is printed on screen by the demo itself, in the line that survives the cut.

Output docs/media/mcp-spend-cap.gif

Require node

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 20
Set Width 1010
Set Height 940
Set Padding 20
Set BorderRadius 8
Set Framerate 12
Set TypingSpeed 55ms

# GitHub dark, so the clip sits in a README without shouting.
Set Theme { "background": "#0d1117", "foreground": "#e6edf3", "cursor": "#e6edf3", "selection": "#264f78", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

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

# Act one, in full: the fleet the agent already has, its spend against the cap, and a create
# the cap still allows.
Sleep 16s

# The wait. The demo polls `list_servers` on its own and narrates the elapsed time in place;
# ROCKYSURF_DEMO_ACT2_AT_MS holds the next create until a fixed point past the crossing, so
# this stretch is a known length rather than a guess at a tick boundary.
Hide
Sleep 80s
Show

# Act two: the crossed-the-cap line still on screen, then the create that is refused.
Sleep 13s

# A held final frame, so the refusal is still there when the GIF loops.
Sleep 4s
