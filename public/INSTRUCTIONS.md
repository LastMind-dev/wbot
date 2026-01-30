# Adaptação do WhatsApp Bot

Esta adaptação integra a biblioteca `whatsapp-web.js` com o sistema PHP existente.

## Arquivos Criados/Modificados

- **server.js**: O servidor Node.js que atua como ponte entre o WhatsApp e o PHP.
  - Recebe requisições de envio do PHP (`/api/agendar-text`).
  - Envia webhooks para o PHP quando mensagens são recebidas.
  - Conecta ao banco de dados MySQL para validar tokens e atualizar status.
- **.env.dev**: Arquivo de configuração. Renomeie ou use como base para o seu ambiente.
- **package.json**: Dependências adicionadas (`express`, `mysql2`, `axios`, `qrcode`).

## Como Instalar e Rodar

1.  **Instale as dependências**:
    No diretório `c:\xampp\htdocs\whatsapp-web.js-main`, execute:
    ```bash
    npm install
    ```

2.  **Configure o Banco de Dados**:
    Edite o arquivo `.env.dev` com as credenciais corretas do seu MySQL e o ID da instância que este bot controlará.
    ```env
    DB_HOST=localhost
    DB_USER=root
    DB_PASSWORD=
    DB_NAME=tabel_wbot1
    INSTANCE_ID=seu_uuid_aqui
    ```

3.  **Inicie o Servidor**:
    ```bash
    npm start
    ```

4.  **Autenticação**:
    - Na primeira execução, um QR Code será gerado.
    - Ele será salvo como `qrcode.png` na raiz do projeto.
    - Abra este arquivo e escaneie com o WhatsApp do celular.
    - O console mostrará "Client is ready!" quando conectado.

## Funcionamento

- **Envio de Mensagens**: O sistema PHP (via `agendar.php`) envia um POST para `http://localhost:3000/api/agendar-text`. O `server.js` processa e envia pelo WhatsApp.
- **Recebimento de Mensagens**: Quando o WhatsApp recebe uma mensagem (ex: "1" ou "2"), o `server.js` consulta a tabela `instances` para obter a URL do webhook e envia os dados para o `retorno.php`.
