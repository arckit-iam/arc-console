# ARC Console

Console web de la plateforme [Instant Access Provider](https://github.com/arckit-iam/InstantAccessPublisher). Elle remplace `arc-gateway` et `arc-gateway-frontend-node` (authentification Kerberos/SPNEGO) par une authentification par **jeton JWT** émis par [arc-auth](https://github.com/arckit-iam/arc-auth).

Elle permet de gérer :

- les **produits** et leurs **profils** (groupes) via [product-manager](https://github.com/arckit-iam/product-manager) ;
- les **comptes applicatifs** (non utilisateurs), rattachés à un produit ;
- les **identités** humaines via [identity-manager](https://github.com/arckit-iam/identity-manager) ;
- les **comptes utilisateurs**, rattachés à une identité ;
- la consultation des **types de compte** (définis par la configuration du déploiement).

```text
Navigateur ──► arc-console (même origine) ──► /auth/token   ──► arc-auth
                                           ├─► /api/pm/*    ──► product-manager
                                           └─► /api/im/*    ──► identity-manager
```

## Fonctionnement

1. Le formulaire de connexion envoie l'identifiant et le mot de passe à `POST /auth/token`, relayé vers `POST /token` d'arc-auth.
2. Le jeton JWT (`access_token`) est conservé dans le `sessionStorage` du navigateur (effacé à la fermeture de l'onglet). Les rôles (`ARC_ADMIN`, `ARC_PUBLISHER`, `ARC_READER`) sont lus dans le claim `roles` pour afficher ou masquer les actions d'écriture ; **les droits sont toujours contrôlés par les API**.
3. Chaque appel de l'interface passe par `/api/pm/*` ou `/api/im/*` avec `Authorization: Bearer <jwt>`. Le serveur relaie la requête sans rien modifier ni journaliser du jeton. Il n'y a donc ni CORS ni secret côté navigateur.
4. Un `401` renvoie à l'écran de connexion.

Le serveur n'a aucune dépendance npm : il sert les fichiers statiques de `public/` (en-têtes `Content-Security-Policy` stricts, aucune donnée affichée via `innerHTML`) et relaie les appels. Seules les méthodes `GET`, `POST`, `PUT` et `DELETE` sont relayées, les corps sont limités à 1 Mo.

## Configuration

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `ARC_AUTH_URL` | `http://arc-auth:8082` | URL d'arc-auth |
| `ARC_PRODUCT_MANAGER_URL` | `http://product-manager:8080` | URL de product-manager |
| `ARC_IDENTITY_MANAGER_URL` | `http://identity-manager:8083` | URL d'identity-manager |

Sonde de disponibilité : `GET /healthz`.

## Démarrage local

Prérequis : Node.js 20 ou plus, ou Docker.

```bash
ARC_AUTH_URL=http://localhost:8082 \
ARC_PRODUCT_MANAGER_URL=http://localhost:8080 \
ARC_IDENTITY_MANAGER_URL=http://localhost:8083 \
npm start
```

```bash
docker build -t arc-console .
docker run --rm -p 3000:3000 -e ARC_AUTH_URL=... -e ARC_PRODUCT_MANAGER_URL=... -e ARC_IDENTITY_MANAGER_URL=... arc-console
```

L'interface est disponible sur `http://localhost:3000`. Le démonstrateur complet (arc-auth, arc-publisher, product-manager, identity-manager, Kafka, annuaire) est décrit dans le dépôt principal.

## Développement

```bash
npm test      # tests du serveur (node --test)
```

## Déploiement

Le déploiement GitOps (Helm, FluxCD) est géré dans un dépôt privé. L'intégration et la mise en production de la plateforme sont proposées par Dédale Solutions en **service payant** : pour en discuter, contactez-nous à [etiennsalle@gmail.com](mailto:etiennsalle@gmail.com). Les workflows GitHub Actions (`build.yml`, `promote.yml`) construisent et publient l'image sur GHCR.

Placer la console derrière un reverse proxy TLS : le jeton circule dans l'en-tête `Authorization`.

## Contribuer et sécurité

Voir [CONTRIBUTING.md](CONTRIBUTING.md) et [SECURITY.md](SECURITY.md).

## Licence

Copyright © 2026 Dédale Solutions

Ce projet est distribué sous la licence [EUPL-1.2](LICENSE) (European Union Public Licence v. 1.2).
