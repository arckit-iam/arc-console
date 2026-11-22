# Contribuer à arc-console

Merci de l'intérêt porté à ce projet. Les contributions (corrections, tests, documentation, nouvelles fonctionnalités) sont les bienvenues.

## Avant de commencer

- Pour un changement important, ouvrir d'abord une *issue* afin d'en discuter.
- Pour une faille de sécurité, ne pas ouvrir d'*issue* publique : suivre [SECURITY.md](SECURITY.md).

## Environnement de développement

Prérequis : Node.js 20 ou plus (aucune dépendance npm).

```bash
npm test
```

## Proposer un changement

1. Forker le dépôt et créer une branche dédiée (`feat/...`, `fix/...`, `docs/...`).
2. Ne jamais afficher une donnée de l'API autrement que par `textContent` (pas de `innerHTML`) et ne pas ajouter de dépendance sans nécessité.
3. Ajouter ou mettre à jour les tests. Les tests utilisent `node --test`.
4. Mettre à jour la documentation concernée.
5. Utiliser des messages de commit au format [Conventional Commits](https://www.conventionalcommits.org/fr/) (`feat:`, `fix:`, `docs:`, `chore:`...).
6. Ouvrir une *pull request* vers la branche principale.

## Licence et conformité

Le projet est distribué sous licence [EUPL-1.2](LICENSE) et respecte la spécification [REUSE](https://reuse.software/).

- Tout nouveau fichier JavaScript commence par l'en-tête :

  ```js
  // SPDX-FileCopyrightText: <année> <titulaire>
  // SPDX-License-Identifier: EUPL-1.2
  ```

- Les autres fichiers sont couverts par `REUSE.toml`.
- Vérification : `pip install reuse` puis `reuse lint`.

## Certificat d'origine (DCO)

En soumettant une contribution, vous certifiez, au sens du [Developer Certificate of Origin](https://developercertificate.org/), avoir le droit de la proposer sous licence EUPL-1.2. Chaque commit doit comporter la mention `Signed-off-by` :

```bash
git commit -s -m "fix: corrige ..."
```

## Code de conduite

Les échanges restent courtois et constructifs. Les comportements irrespectueux ou discriminatoires ne sont pas tolérés.
