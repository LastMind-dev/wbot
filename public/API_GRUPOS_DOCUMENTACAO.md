# 📱 API de Grupos WhatsApp - Documentação

Esta documentação descreve os endpoints disponíveis para gerenciamento de grupos WhatsApp.

## Base URL
```
http://localhost:3000
```

---

## 🔐 Autenticação

A maioria dos endpoints requer o `instance` (ID da instância) no corpo da requisição ou como parâmetro de URL.

---

## 📋 Endpoints de Grupos WhatsApp

### 1. Criar Grupo

Cria um novo grupo no WhatsApp.

**Endpoint:** `POST /api/group/create`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "name": "Nome do Grupo",
    "participants": ["5511999999999", "5511888888888"],
    "description": "Descrição do grupo (opcional)"
}
```

**Resposta de Sucesso:**
```json
{
    "success": true,
    "message": "Grupo criado com sucesso",
    "group": {
        "id": "123456789@g.us",
        "name": "Nome do Grupo",
        "participants": { ... }
    }
}
```

---

### 2. Listar Grupos

Lista todos os grupos da instância.

**Endpoint:** `GET /api/group/list/:instance`

**Exemplo:** `GET /api/group/list/uuid-da-instancia`

**Resposta:**
```json
{
    "success": true,
    "count": 5,
    "groups": [
        {
            "id": "123456789@g.us",
            "name": "Grupo 1",
            "participantsCount": 10,
            "isReadOnly": false,
            "timestamp": 1701234567
        }
    ]
}
```

---

### 3. Informações do Grupo

Obtém detalhes de um grupo específico.

**Endpoint:** `GET /api/group/info/:instance/:groupId`

**Exemplo:** `GET /api/group/info/uuid-da-instancia/123456789@g.us`

**Resposta:**
```json
{
    "success": true,
    "group": {
        "id": "123456789@g.us",
        "name": "Nome do Grupo",
        "description": "Descrição",
        "owner": "5511999999999@c.us",
        "participants": [
            {
                "id": "5511999999999@c.us",
                "isAdmin": true,
                "isSuperAdmin": true
            }
        ],
        "createdAt": 1701234567,
        "isReadOnly": false
    }
}
```

---

### 4. Adicionar Participantes

Adiciona participantes a um grupo existente.

**Endpoint:** `POST /api/group/add-participants`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "groupId": "123456789@g.us",
    "participants": ["5511777777777", "5511666666666"]
}
```

**Resposta:**
```json
{
    "success": true,
    "message": "Participantes processados",
    "result": { ... }
}
```

---

### 5. Remover Participantes

Remove participantes de um grupo.

**Endpoint:** `POST /api/group/remove-participants`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "groupId": "123456789@g.us",
    "participants": ["5511777777777"]
}
```

---

### 6. Enviar Mensagem para Grupo

Envia uma mensagem de texto para um grupo.

**Endpoint:** `POST /api/group/send-message`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "groupId": "123456789@g.us",
    "message": "Olá pessoal! Esta é uma mensagem para o grupo."
}
```

**Resposta:**
```json
{
    "success": true,
    "message": "Mensagem enviada para o grupo",
    "messageId": "true_123456789@g.us_ABC123"
}
```

---

### 7. Obter Link de Convite

Obtém o link de convite do grupo.

**Endpoint:** `GET /api/group/invite-link/:instance/:groupId`

**Resposta:**
```json
{
    "success": true,
    "inviteCode": "ABC123XYZ",
    "inviteLink": "https://chat.whatsapp.com/ABC123XYZ"
}
```

---

### 8. Atualizar Grupo

Atualiza nome e/ou descrição do grupo.

**Endpoint:** `POST /api/group/update`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "groupId": "123456789@g.us",
    "name": "Novo Nome do Grupo",
    "description": "Nova descrição"
}
```

---

## 📁 Endpoints de Grupos Locais (Banco de Dados)

Estes endpoints permitem gerenciar grupos salvos no banco de dados local, útil para integração com sistemas PHP.

### 9. Listar Grupos Locais

**Endpoint:** `GET /api/local-groups/:instance`

**Resposta:**
```json
{
    "success": true,
    "count": 3,
    "groups": [
        {
            "id": 1,
            "instance_id": "uuid",
            "group_id": "123456789@g.us",
            "name": "Clientes VIP",
            "description": "Grupo de clientes especiais",
            "member_count": 15,
            "created_at": "2024-01-01T00:00:00.000Z"
        }
    ]
}
```

---

### 10. Criar Grupo Local

Cria um grupo no WhatsApp e salva no banco local.

**Endpoint:** `POST /api/local-groups/create`

**Body:**
```json
{
    "instance": "uuid-da-instancia",
    "name": "Clientes VIP",
    "description": "Grupo para clientes especiais",
    "members": [
        {"phone": "5511999999999", "name": "João Silva"},
        {"phone": "5511888888888", "name": "Maria Santos"}
    ]
}
```

**Resposta:**
```json
{
    "success": true,
    "message": "Grupo criado com sucesso",
    "localGroupId": 1,
    "whatsappGroupId": "123456789@g.us",
    "name": "Clientes VIP"
}
```

---

### 11. Adicionar Membro ao Grupo Local

**Endpoint:** `POST /api/local-groups/add-member`

**Body:**
```json
{
    "localGroupId": 1,
    "phone": "5511666666666",
    "name": "Pedro Costa"
}
```

---

### 12. Listar Membros do Grupo Local

**Endpoint:** `GET /api/local-groups/:localGroupId/members`

**Resposta:**
```json
{
    "success": true,
    "count": 5,
    "members": [
        {
            "id": 1,
            "group_id": 1,
            "phone_number": "5511999999999",
            "name": "João Silva",
            "is_admin": false,
            "added_at": "2024-01-01T00:00:00.000Z"
        }
    ]
}
```

---

### 13. Enviar Mensagem para Grupo Local

**Endpoint:** `POST /api/local-groups/send-message`

**Body:**
```json
{
    "localGroupId": 1,
    "message": "Mensagem para o grupo"
}
```

---

## 🐘 Integração com PHP

### Classe PHP

Use a classe `WhatsAppGroupsAPI.php` localizada em `/php-integration/`:

```php
<?php
require_once 'WhatsAppGroupsAPI.php';

$api = new WhatsAppGroupsAPI('http://localhost:3000', 'sua-instance-id');

// Criar grupo
$result = $api->createGroup('Meu Grupo', ['5511999999999']);

// Listar grupos
$grupos = $api->listGroups();

// Enviar mensagem
$api->sendMessageToGroup('123456789@g.us', 'Olá!');
```

---

## 📊 Tabelas do Banco de Dados

### whatsapp_groups
| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | INT | ID local (auto increment) |
| instance_id | VARCHAR(255) | ID da instância |
| group_id | VARCHAR(255) | ID do grupo no WhatsApp |
| name | VARCHAR(255) | Nome do grupo |
| description | TEXT | Descrição |
| created_by | VARCHAR(255) | Número que criou |
| created_at | TIMESTAMP | Data de criação |

### whatsapp_group_members
| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | INT | ID (auto increment) |
| group_id | INT | FK para whatsapp_groups |
| phone_number | VARCHAR(50) | Telefone do membro |
| name | VARCHAR(255) | Nome do membro |
| is_admin | BOOLEAN | É admin? |
| added_at | TIMESTAMP | Data de adição |

---

## ⚠️ Códigos de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Parâmetros inválidos ou faltando |
| 403 | Token inválido |
| 404 | Recurso não encontrado |
| 500 | Erro interno do servidor |
| 503 | Instância não conectada |

---

## 🚀 Exemplo Completo em PHP

```php
<?php
require_once 'WhatsAppGroupsAPI.php';

$api = new WhatsAppGroupsAPI('http://localhost:3000', 'sua-instance-id');

// 1. Verificar conexão
$status = $api->getStatus();
if ($status['status'] !== 'CONNECTED') {
    die('WhatsApp não conectado!');
}

// 2. Criar grupo com membros
$grupo = $api->createLocalGroup(
    'Promoções Dezembro',
    'Grupo para divulgar promoções',
    [
        ['phone' => '5511999999999', 'name' => 'Cliente 1'],
        ['phone' => '5511888888888', 'name' => 'Cliente 2']
    ]
);

if ($grupo['success']) {
    $localId = $grupo['localGroupId'];
    
    // 3. Enviar mensagem de boas-vindas
    $api->sendMessageToLocalGroup($localId, '🎉 Bem-vindos ao grupo de promoções!');
    
    // 4. Adicionar mais um membro
    $api->addMemberToLocalGroup($localId, '5511777777777', 'Cliente 3');
    
    echo "Grupo criado com sucesso! ID: " . $localId;
}
?>
```

---

## 📞 Suporte

Para dúvidas ou problemas, verifique:
1. Se a instância está conectada (status CONNECTED)
2. Se o servidor Node.js está rodando
3. Se o banco de dados está acessível
4. Os logs do servidor para mensagens de erro detalhadas
