start_server:
	export $$(grep -v '^\s*#' .env | grep -v '^\s*$$' | xargs) && ~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev
