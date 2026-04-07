#!/usr/bin/env bash
set -euo pipefail

# ralph-prd installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tahaJemmali/ralph-prd/main/install.sh | bash
#   — or —
#   git clone https://github.com/tahaJemmali/ralph-prd.git /tmp/ralph-prd && /tmp/ralph-prd/install.sh

REPO="tahaJemmali/ralph-prd"
BRANCH="main"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { printf "${CYAN}[ralph-prd]${RESET} %s\n" "$1"; }
ok()    { printf "${GREEN}[ralph-prd]${RESET} %s\n" "$1"; }
fail()  { printf "${RED}[ralph-prd]${RESET} %s\n" "$1" >&2; exit 1; }

# Detect project root (nearest .git ancestor or cwd)
find_project_root() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    [ -d "$dir/.git" ] && echo "$dir" && return
    dir="$(dirname "$dir")"
  done
  echo "$PWD"
}

PROJECT_ROOT="$(find_project_root)"
CLAUDE_DIR="$PROJECT_ROOT/.claude"

info "Installing into $CLAUDE_DIR"

# Determine source: local clone or download
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "$SCRIPT_DIR/ralph" ] && [ -d "$SCRIPT_DIR/skills" ]; then
  # Running from a local clone
  SOURCE_DIR="$SCRIPT_DIR"
  info "Source: local ($SOURCE_DIR)"
else
  # Download from GitHub
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
  info "Downloading from github.com/$REPO..."

  if command -v git &>/dev/null; then
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMPDIR/ralph-prd" 2>/dev/null
    SOURCE_DIR="$TMPDIR/ralph-prd"
  elif command -v curl &>/dev/null; then
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar xz -C "$TMPDIR"
    SOURCE_DIR="$TMPDIR/ralph-prd-$BRANCH"
  else
    fail "Neither git nor curl found. Install one and retry."
  fi
fi

# Create .claude dir if needed
mkdir -p "$CLAUDE_DIR"

# Copy ralph runner
if [ -d "$CLAUDE_DIR/ralph" ]; then
  info "Updating existing .claude/ralph/"
  rm -rf "$CLAUDE_DIR/ralph"
fi
cp -r "$SOURCE_DIR/ralph" "$CLAUDE_DIR/ralph"
ok "Installed ralph runner -> .claude/ralph/"

# Copy skills
mkdir -p "$CLAUDE_DIR/skills"
for skill_dir in "$SOURCE_DIR/skills"/*/; do
  skill_name="$(basename "$skill_dir")"
  if [ -d "$CLAUDE_DIR/skills/$skill_name" ]; then
    info "Updating existing skill: $skill_name"
    rm -rf "$CLAUDE_DIR/skills/$skill_name"
  fi
  cp -r "$skill_dir" "$CLAUDE_DIR/skills/$skill_name"
  ok "Installed skill: $skill_name"
done

# Remove logs and test dirs from installed copy (not needed in target project)
rm -rf "$CLAUDE_DIR/ralph/logs" "$CLAUDE_DIR/ralph/test"

# Summary
echo ""
ok "ralph-prd installed successfully!"
echo ""
info "Installed to: $CLAUDE_DIR"
info ""
info "Quick start:"
info "  1. Write a PRD:    claude then /write-a-prd"
info "  2. Create a plan:  claude then /prd-to-plan"
info "  3. Execute:        node .claude/ralph/ralph-claude.mjs docs/<feature>/plan.md"
echo ""
info "Docs: https://github.com/$REPO"
