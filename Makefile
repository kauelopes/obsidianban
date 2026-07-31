PID_FILE := .run/server.pid
LOG_FILE := .run/server.log
PNPM := ~/.local/share/pnpm/bin/pnpm

.PHONY: start_server server-build server-start server-stop server-restart server-status server-logs

# Dev mode em foreground (hot reload via tsx watch) — para trabalhar no código do servidor.
start_server:
	export $$(grep -v '^\s*#' .env | grep -v '^\s*$$' | xargs) && $(PNPM) --filter obsidiankan-mcp run dev

server-build:
	$(PNPM) run build

# Servidor de produção (dist/, sem hot reload) rodando em background, com .env
# carregado por inteiro — é o modo certo para o servidor de longa duração que
# o sprint workflow depende (WORKFLOW_ENABLED, WORKFLOW_SCRIPT_PATH,
# ANTHROPIC_API_KEY). Nunca suba o servidor de outra forma (nohup manual,
# snapshot de env capturado à mão) — variáveis faltando quebram o auto-launch
# do workflow silenciosamente (só um logger.warn, sem erro visível).
server-start: server-build
	@mkdir -p .run
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "server já rodando (pid $$(cat $(PID_FILE)))"; \
	else \
		( set -a && . ./.env && set +a && \
		  nohup node packages/server/dist/index.js > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE) ); \
		sleep 1; \
		echo "server iniciado (pid $$(cat $(PID_FILE))), log: $(LOG_FILE)"; \
	fi

server-stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		kill $$(cat $(PID_FILE)); \
		echo "parado (pid $$(cat $(PID_FILE)))"; \
	else \
		echo "nenhum server rastreado em $(PID_FILE) (rodando? confira 'make server-status' ou 'ps aux | grep dist/index.js')"; \
	fi; \
	rm -f $(PID_FILE)

server-restart: server-stop server-start

server-status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "rodando (pid $$(cat $(PID_FILE)))"; \
	else \
		echo "não rastreado como rodando (pidfile ausente ou processo morto)"; \
	fi; \
	curl -s http://127.0.0.1:$${MCP_HTTP_PORT:-9375}/health && echo || echo "health check falhou"

server-logs:
	tail -f $(LOG_FILE)
