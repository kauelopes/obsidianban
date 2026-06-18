rebuild_obsidian:
	OBSIDIANKAN_DEV_VAULT=/home/kaue.moraes/Projects/kanban ~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/plugin build

start_server:
	export $$(grep -v '^\s*#' .env | grep -v '^\s*$$' | xargs) && ~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev
