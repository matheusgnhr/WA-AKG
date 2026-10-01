# Correções de segurança do fork Pegalead — 01/10/2026

**Veredito global: PARTIAL.** Os achados A1–A13 da revisão inicial foram tratados
no fork local, com regressões e revisão independente. Isso não certifica todas as
rotas, dependências ou o transporte WhatsApp. O lint integral do upstream continua
falhando e os ensaios com conta WhatsApp e Docker não foram executados.

Base upstream: `c7dd01a04339e4363b549beb3a41fe02cf131acb`, pacote 1.6.4.
Branch local: `codex/pegalead-security`. Licença MIT preservada. A tag upstream
`v1.7.0-beta.1` apontava para essa mesma base, apesar de anunciar correções ausentes.
Este fork não foi publicado nem aplicado a produção.

## Registro das correções

| Achado | Mudança implementada | Verificação |
| --- | --- | --- |
| A1 — Socket.IO | Handshake por cookie/chave válida, identidade do banco, ACL, origem, salas `session:<id interno>`, revogação e revalidação | HTTP/Socket.IO reais, testes adversariais isolados |
| A2 — SSRF e limites | DNS público validado e IP fixado à conexão; redirects, metadata e redes reservadas bloqueados; prazo e limites de corpo | HTTP local real; controles negativos DNS/URL |
| A3 — escrita de mídia | Identificadores validados, nomes opacos, extensão permitida, arquivos privados, publicação atômica, bloqueio de symlink/overwrite | FS real e regressões negativas |
| A4 — confusão de identidade | Resolução canônica nas rotas que aceitam ambos; transportes legados exigem slug público; reservas permanentes de slug e ID interno | Colisão/reuso com MariaDB; revisão independente |
| A5/A6 — bootstrap e cadastro | Cadastro fechado sem configuração; branding preserva flag; bootstrap recusa promover conta pública e exige senha nova | HTTP/DB e execução real do script |
| A7 — mídia sem ACL | Nomes sem vínculo rejeitados, ACL por ID interno, download confere mensagem/sessão e armazenamento permitido | HTTP real entre duas contas |
| A8 — API keys | CSPRNG de 256 bits, digest SHA-256, segredo exibido uma vez, rotação/revogação desconectam sockets; UI exige estado carregado e confirmação | HTTP, Socket.IO e Chromium; corrida de UI isolada |
| A9 — credenciais | AES-256-GCM com contexto da linha; erros não reinicializam credenciais silenciosamente; FK da sessão impede escrita órfã | Banco real, reload, migração explícita e rejeição de escrita tardia |
| A10 — telemetria | Desligada por padrão; opção explícita envia apenas versão, com prazo | Inspeção do startup; endpoint externo não acionado |
| A11 — Swagger | Removidos segredo público e gate em sessionStorage; autenticação no servidor | HTTP e Chromium reais |
| A12 — instalação/container | Sem postinstall/patch ou bootstrap automático; bind privado, DB dedicado sem porta pública; container não root; dados/segredos fora do build context | Startup real no host; Docker somente inspecionado |
| A13 — disparos soltos | Broadcast e spam retornam 410 após auth/ACL; scheduler desativado por padrão | HTTP real; concorrência de claim no DB com remetente simulado |

Também foram corrigidos: edição de AutoReply alheia e remoção de labels alheias;
webhooks de compartilhamento revogado; segredo HMAC obrigatório inclusive para
legados; redirecionamento externo de login; dupla exclusão de sessão sem await;
exclusão de usuário deixando sessões/credenciais ativas; inicialização/reconexão
terminando após shutdown; falhas e hangs no fetch; escrita parcial de mídia;
dependência vulnerável de figurinhas e incompatibilidade CJS com Baileys rc14.

A exclusão administrativa primeiro marca a conta `disabled`, revoga a chave e
desconecta sockets. A criação de sessão verifica essa flag sob lock do registro
User na transação. Start/stop/delete usam lock por sessão no manager. A instância
invalida inicializações e eventos antigos por geração. Se a exclusão falhar, a
conta fica bloqueada e o administrador pode repetir a operação; não se restaura
automaticamente uma conta cujas sessões já foram parcialmente removidas.

## Dependências e compatibilidade

Next 16.3.8, next-auth beta.32 e Baileys 7.0.0-rc14 foram fixados; transitivos
afetados também foram atualizados pelo lockfile. As atualizações respondem à
[release Next de setembro](https://nextjs.org/blog/september-2026-security-release)
e ao [advisory Baileys](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg).
Os dois scans finais, com todas as dependências e somente produção, retornaram
**exit 0 / zero alertas**. O resultado depende da base de advisories nessa data;
não é prova de ausência de vulnerabilidades desconhecidas ou malware.

O patch antigo de Baileys rc9 está arquivado em `upstream-rc9-reference.patch`,
sem execução. Baileys rc14 exige ESM; os scripts CommonJS foram renomeados para
`.cjs`. O conversor local usa Sharp, limita pixels/frames/bytes e preserva
metadados, transparência circular e animação GIF. Vídeo depende de ffmpeg e não
foi executado no host. Compatibilidade de envio, newsletter, sincronização e
pareamento rc14 ainda depende de ensaios WhatsApp reais.

## Instalação e migração explícitas

Use Node.js 24 e um banco MySQL compatível, dedicado. Não compartilhe uma sessão
Baileys entre réplicas do gateway: a operação suportada por este fork é um único
processo. O ensaio local usou MariaDB 13.0.2 via conector MySQL, em loopback;
não validou Oracle MySQL, PostgreSQL externo ou produção.

1. Instale o lockfile com `npm ci --ignore-scripts`; gere o cliente com
   `node node_modules/prisma/build/index.js generate`.
2. Configure `.env.local` com permissão 600, usuário de DB dedicado, URL privada,
   `AUTH_SECRET` novo e chave `WA_AUTH_ENCRYPTION_KEY` de 32 bytes em base64.
   Preserve essa chave separadamente dos backups criptografados. Valores em
   `.env.example` são instruções, não credenciais utilizáveis.
3. Em banco novo e isolado, aplique o schema explicitamente com Prisma. Para
   banco existente, pare o gateway, faça backup e revise o diff/migração antes
   de aplicar: novos campos incluem `User.disabled`, `SessionIdentifier` e FK
   de AuthState. Credenciais órfãs exigem revisão antes da FK; não apagá-las
   silenciosamente para fazer a migração passar.
4. Com o schema aplicado, execute `security/session-identity-migration.sql`:
   preenche as reservas permanentes, fecha o default de cadastro, desativa hooks
   sem segredo e revoga chaves legadas em texto. O startup bloqueia reservas
   ausentes. Não apague reservas ao remover sessões ou usuários.
5. Credenciais antigas em JSON devem ser migradas offline: `node node_modules/tsx/dist/cli.mjs
   security/migrate-auth-state.ts` faz dry-run e `--apply` aplica. O script valida
   todos os registros antes da transação, é idempotente e não imprime segredos.
   A chave incorreta interrompe a execução. O runtime rejeita plaintext legado.
6. Mídias antigas sem ID interno no nome ficam bloqueadas. Revise propriedade
   e referências antes de migrar arquivos; não habilite fallback público. O
   usuário informou não possuir instância anterior, portanto não havia dados
   reais para migrar nesta execução.
7. Crie o admin com `npm run make-admin -- email@example.invalid`, fornecendo
   `ADMIN_PASSWORD` pelo ambiente ou arquivo privado. O script não promove
   conta pública preexistente. Rode `npm run build` e `npm start`.

Docker/Compose não executam migração ou bootstrap no boot. Prepare o banco e o
admin explicitamente antes de expor a aplicação. O compose publica somente
loopback e não publica a porta do DB. Este caminho ainda está **NOT_RUN**.

## Verificação e limites

Comandos executados no fork com Node 24.21.0/npm 11.19.0:

| Checagem | Resultado |
| --- | --- |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| `npm run test:security` | PASS, 11 testes, nenhum skip |
| `npm run test:security:e2e` | PASS, 5 jornadas, nenhum skip |
| Gateway HTTP/Socket.IO + DB | 66 verificações, incluindo negações, efeitos proibidos, rotação, exclusão e credencial tardia |
| Chromium | Login real, destino interno, lookup de chave lento/503, confirmação/cancelamento, retry e Swagger |
| Webhook | HTTP local real, assinatura sobre bytes, logs no DB, revogação de compartilhamento e bloqueio de unsigned |
| Scheduler | Banco real, dois workers/um claim; remetente simulado; ambiguidades viram UNKNOWN sem retry |
| Bootstrap/migração | Script real, recusa de promoção, dry-run, aplicação, idempotência, chave errada e identidade preservada |
| Lint dos helpers/testes/sockets/scheduler/migração novos | PASS, exit 0 |
| Lint integral | FAIL: 283 errors / 173 warnings; base upstream: 296 / 178 com o mesmo ESLint. Nenhum diagnóstico adicional por arquivo/regra/mensagem na comparação |
| `npm audit` / `npm audit --omit=dev` | PASS, zero alertas |
| WhatsApp real, pareamento, envio/recebimento e newsletter | NOT_RUN |
| Docker, vídeo ffmpeg, DB externo e produção | NOT_RUN |

As jornadas E2E exigem o gateway de produção em loopback e o DB descartável
`wa_akg_security`; recusam outra URL/DB. Testes criam e removem dados sintéticos.
Não usam conta WhatsApp, não iniciam Baileys e não enviam mensagens a pessoas.
Os testes de segurança cobrem controles específicos, não todas as funcionalidades
e páginas upstream. A revisão independente também usou harnesses isolados com
stubs: seus resultados complementam, não substituem, os ensaios reais acima.

Evidências sanitizadas ficam em `evidence/`. A integração funcional no Pegalead
ainda não foi aplicada nesta etapa. Ela deve usar o outbox e consentimento do
Pegalead, assinatura e vínculo sessão/tenant; WA-AKG não oferece idempotência
confirmada. Erro após tentativa de envio exige resultado desconhecido e revisão.
O transporte permanece não oficial, sujeito a mudanças e restrição de conta.
