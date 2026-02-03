# Melhorias de Resiliência - WhatsApp Bot API v3.0

## Resumo das Implementações

Este documento descreve as melhorias estruturais implementadas para garantir máxima resiliência e disponibilidade do sistema de gerenciamento de instâncias WhatsApp.

---

## 1. Separação de Estados de Instância

### Antes
- Apenas coluna `status` (0 ou 1) para indicar estado

### Depois
- **`enabled`** (TINYINT): Define se a instância deve subir automaticamente
  - `1` = Instância deve estar sempre ativa
  - `0` = Instância não será reconectada automaticamente
  
- **`connection_status`** (VARCHAR): Estado atual detalhado
  - `CONNECTED` - Conectado e operacional
  - `DISCONNECTED` - Desconectado
  - `RECONNECTING` - Em processo de reconexão
  - `QR_REQUIRED` - Aguardando QR Code
  - `AUTH_FAILURE` - Falha de autenticação
  - `INITIALIZING` - Inicializando
  - `LOADING` - Carregando dados

### Benefício
O servidor restaura instâncias baseado em `enabled=1`, não no estado momentâneo, evitando que instâncias fiquem permanentemente desconectadas após reinícios.

---

## 2. Persistência Segura de Sessão

### Implementado
- Caminho de armazenamento configurável via `SESSION_STORAGE_PATH`
- Verificação de sessão existente antes de iniciar
- Restauração automática de sessões persistentes
- Proteção contra remoção acidental da pasta `.wwebjs_auth`

### Configuração
```javascript
// Em .env ou config
SESSION_STORAGE_PATH=/caminho/persistente/.wwebjs_auth
```

---

## 3. Reconexão Automática Robusta

### Características
- **Backoff exponencial**: Delays crescentes entre tentativas
- **Jitter aleatório**: Evita thundering herd
- **Limite configurável**: Máximo de 20 tentativas (resetável)
- **Detecção inteligente**: Diferentes delays para diferentes tipos de falha

### Algoritmo
```
delay = min(BASE_DELAY * 1.5^tentativas, MAX_DELAY) + random(0, JITTER_MAX)
```

### Razões que NÃO reconectam
- `LOGOUT` - Usuário deslogou manualmente
- `TOS_BLOCK` - Bloqueio por termos de serviço
- `BANNED` - Conta banida

---

## 4. Health Check Ativo

### Intervalos Configurados
| Check | Intervalo | Função |
|-------|-----------|--------|
| Health Check | 30s | Verifica browser, página, estado |
| Deep Check | 2min | Verifica Store, WebSocket interno, memória |
| Recovery Check | 1min | Detecta zumbis e sessões travadas |
| Memory Check | 5min | Monitora uso de memória |

### Detecções Automáticas
- Browser desconectado
- Página fechada
- Estado LOADING travado
- Sessões zumbis (conectadas mas não respondem)
- Falhas consecutivas de ping

---

## 5. Shutdown Seguro

### Sinais Tratados
- `SIGINT` (Ctrl+C)
- `SIGTERM` (kill)
- `SIGBREAK` (Windows)
- `uncaughtException`
- `unhandledRejection`

### Processo de Shutdown
1. Para todos os intervalos registrados
2. Prepara sessões para shutdown
3. Salva estados no banco de dados
4. Destrói clientes WhatsApp com timeout
5. Fecha pool de conexão do banco
6. Encerra processo

---

## 6. Monitoramento de Memória

### Funcionalidades
- Coleta periódica de estatísticas de memória
- Detecção de memory leak (tendência de crescimento)
- Alertas para heap alto (80%) e crítico (95%)
- Garbage collection forçado quando necessário
- Reinício de instâncias degradadas

### Thresholds
- Heap por instância: 500MB máximo
- Heap total: 2GB máximo
- Warning: 80% do heap
- Critical: 95% do heap

---

## 7. Reidratação Automática

### Comportamento no Startup
1. Servidor inicia
2. Busca instâncias com `enabled=1`
3. Para cada instância:
   - Atualiza status para `RECONNECTING`
   - Aguarda 2s (evita sobrecarga)
   - Inicia sessão
4. Health check começa após 15s

### Comportamento Contínuo
- Recovery check a cada 1 minuto
- Detecta instâncias `enabled=1` sem sessão ativa
- Inicia automaticamente

---

## 8. Logs Estruturados

### Categorias
| Categoria | Uso |
|-----------|-----|
| `INFO` | Eventos normais |
| `WARN` | Degradação, alertas |
| `ERROR` | Falhas críticas |
| `SESSION` | Status de sessões |
| `RECONNECT` | Tentativas de reconexão |
| `HEALTH` | Health checks |
| `MEMORY` | Monitoramento de memória |

### Formato
```
[2024-01-15 10:30:45] [INFO] [SESSION] [instance-id] 📱 Mensagem
```

---

## Novas APIs

### Controle de Instância
```
POST /api/instance/:id/enable   - Habilita auto-start
POST /api/instance/:id/disable  - Desabilita auto-start
GET  /api/instance/:id/details  - Detalhes completos
```

### Monitoramento
```
GET  /api/health         - Status geral do sistema
POST /api/health/check   - Força health check manual
GET  /api/memory/report  - Relatório de memória
```

---

## Arquivos Criados

```
public/
├── lib/
│   ├── config.js         # Configurações centralizadas
│   ├── logger.js         # Sistema de logs estruturados
│   ├── sessionManager.js # Gerenciador de sessões
│   ├── shutdownHandler.js # Handler de shutdown gracioso
│   └── memoryMonitor.js  # Monitor de memória
└── RESILIENCE_IMPROVEMENTS.md  # Esta documentação
```

---

## Configuração

### Variáveis de Ambiente Opcionais
```env
SESSION_STORAGE_PATH=/caminho/persistente/.wwebjs_auth
CACHE_PATH=/caminho/persistente/.wwebjs_cache
LOG_LEVEL=INFO
```

### Ajustes de Tempo (em lib/config.js)
Todos os intervalos, timeouts e thresholds podem ser ajustados no arquivo `lib/config.js` na constante `RESILIENCE_CONFIG`.

---

## Resultado Esperado

✅ Restaurar sessões após restart do servidor
✅ Manter instâncias conectadas por longos períodos
✅ Reconectar automaticamente após falhas
✅ Evitar QR Code desnecessário (sessão persistente)
✅ Operar de forma resiliente e escalável
✅ Detectar e recuperar sessões problemáticas
✅ Monitorar uso de recursos
✅ Shutdown gracioso sem corrupção de dados
