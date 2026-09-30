# Gladys Mammotion

Intégration externe [Gladys Assistant](https://gladysassistant.com) pour les
robots tondeuses **Mammotion** (Luba, Luba 2, Luba mini, Yuka…), construite sur
le [template officiel](https://github.com/GladysAssistant/integration-template-js)
et le SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## Fonctionnalités

Chaque tondeuse du compte Mammotion devient un appareil Gladys avec :

| Fonctionnalité   | Type Gladys             | Rôle                                                       |
| ---------------- | ----------------------- | ---------------------------------------------------------- |
| Tonte            | interrupteur (commande) | `1` = lancer / reprendre la tonte, `0` = pause             |
| Retour à la base | interrupteur (commande) | `1` = retour à la base, `0` = annuler le retour            |
| État             | texte                   | « En tonte », « En charge », « En pause », « Hors ligne »… |
| Batterie         | batterie (%)            | niveau de charge                                           |
| En charge        | batterie (binaire)      | `1` quand la tondeuse charge sur sa base                   |
| Hauteur de coupe | distance (mm)           | hauteur des lames                                          |
| Temps de tonte   | durée (h)               | compteur total                                             |
| Distance totale  | distance (km)           | compteur total                                             |

Les valeurs sont lues sur le cloud Mammotion toutes les **`poll_frequency`**
secondes (réglable dans l'écran de configuration, 60 s par défaut, de 30 à
3600 s). Après une commande, la tondeuse est relue au bout de 10 s.

Deux boutons sont disponibles dans l'écran de configuration :
**Tester la connexion** et **Rafraîchir les tondeuses**.

## Configuration

| Champ                              | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| Email / Mot de passe               | compte de l'application Mammotion                     |
| Intervalle de rafraîchissement (s) | `poll_frequency` : fréquence de lecture (30 à 3600 s) |
| Langue de l'état                   | langue du texte « État » (français ou anglais)        |

> Conseil : créez un second compte Mammotion, partagez-lui la tondeuse depuis
> l'application, et utilisez ce compte dans Gladys. Sinon l'application sur
> votre téléphone peut être déconnectée.

## Comment ça marche

- `src/mammotion/client.js` : connexion OAuth Mammotion, liste des tondeuses,
  lecture de l'état, envoi des commandes.
- `src/mammotion/aliyun.js` : passerelle Aliyun IoT (signature des requêtes),
  encore utilisée par la plupart des Luba / Yuka.
- `src/mammotion/mqtt.js` : broker MQTT Mammotion, pour les tondeuses qui ne
  sont pas sur Aliyun (erreur « user device not bind »). Ces tondeuses
  envoient elles-mêmes leur état : les valeurs arrivent quand la tondeuse les
  publie (pas de lecture à la demande).
- `src/mammotion/commands.js` + `protobuf.js` : commandes au format protobuf
  (`LubaMsg` → `NavTaskCtrl` : start, pause, resume, stop, dock…).
- `src/mammotion/telemetry.js` : lecture des propriétés (batterie, état…).
- `src/devices/mower.js` : l'appareil Gladys et ses fonctionnalités.
- `index.js` : branchement du SDK Gladys (découverte, poll, commandes, actions).

Le protocole cloud Mammotion n'est pas documenté officiellement : cette
intégration reprend le fonctionnement des projets communautaires
[PyMammotion](https://github.com/mikey0000/PyMammotion) et
[ioBroker.mammotion](https://github.com/DNAngelX/ioBroker.mammotion).

## Lancer en local

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="mammotion" \
LOG_LEVEL=debug \
npm start
```

## Contrôles qualité

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # tests unitaires (node --test)
```

## Publier

1. Ajouter le topic GitHub `gladys-assistant-integration` au dépôt.
2. **Actions → Release → Run workflow** : le workflow monte la version
   (`package.json` + manifeste), crée le tag et publie l'image Docker
   multi-arch sur `ghcr.io/prohand/gladys-mammotion`.
3. Vérifier avant publication : `npx github:GladysAssistant/integration-store .`

## Licence

Apache-2.0
