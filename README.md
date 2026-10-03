# Gladys Mammotion

Intégration externe [Gladys Assistant](https://gladysassistant.com) pour les
robots tondeuses **Mammotion** (Luba, Luba 2, Luba mini, Yuka…), construite sur
le [template officiel](https://github.com/GladysAssistant/integration-template-js)
et le SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## Fonctionnalités

Chaque tondeuse du compte Mammotion devient un appareil Gladys avec :

| Fonctionnalité   | Type Gladys             | Rôle                                                       |
| ---------------- | ----------------------- | ---------------------------------------------------------- |
| Tonte            | interrupteur (commande) | `1` = lancer une tonte ou reprendre, `0` = pause           |
| Retour à la base | interrupteur (commande) | `1` = retour à la base, `0` = annuler le retour            |
| Rafraîchir       | bouton poussoir         | demande son état à la tondeuse                             |
| État             | texte                   | « En tonte », « En charge », « En pause », « Hors ligne »… |
| Batterie         | batterie (%)            | niveau de charge                                           |
| En charge        | entrée binaire          | `1` quand la tondeuse charge sur sa base                   |
| Hauteur de coupe | distance (mm)           | hauteur des lames                                          |
| Temps restant    | durée (min)             | temps restant de la tonte en cours                         |
| Temps de tonte   | durée (h)               | compteur total                                             |
| Distance totale  | distance (km)           | compteur total                                             |

Les valeurs sont lues sur le cloud Mammotion toutes les **`poll_frequency`**
secondes (réglable dans l'écran de configuration, 300 s par défaut, de 30 à
3600 s). Après une commande, la tondeuse est relue au bout de 10 s (30 s
après un lancement de tonte). Une commande refusée ou inutile n'envoie rien
à la tondeuse : chaque message la sollicite et gêne l'application Mammotion.

« Tonte » sur une tondeuse prête lance une tonte comme Home Assistant
(`startJob`) : un simple « start » sans trajet perturbe la tondeuse et fait
planter l'application.

1. si une tonte s'est arrêtée en cours (`rpt_work.bp_info` ≠ 0), le trajet en
   cours est relu (`NavReqCoverPath` sub_cmd 2) puis « start » la reprend ;
2. sinon les zones de la carte sont lues : leurs noms (`NavMapNameMsg` →
   `toapp_all_hash_name`, seulement les zones nommées dans l'appli), puis
   tous les éléments de la carte (`NavGetHashList` → `toapp_gethash_ack`,
   trame par trame) dont le type est demandé une fois (`NavGetCommData` →
   `toapp_get_commondata_ack`, type 0 = zone). Un trajet est préparé sur ces
   zones, ou celles choisies dans la configuration (`NavReqCoverPath`
   sub_cmd 0, réglages de la section « Nouvelle tonte »), puis « start ».

Les réponses arrivent sur le broker Mammotion : seules ses tondeuses (pas la
Luba 1, pas celles de la passerelle Aliyun) peuvent lancer une tonte. Le tout
tourne en tâche de fond (Gladys n'attend que 5 s la réponse d'une commande).

Deux boutons sont aussi disponibles dans l'écran de configuration :
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
  sont pas sur Aliyun (erreur « user device not bind »). La tondeuse est
  invitée à envoyer son état (`todev_report_cfg`) au plus toutes les 5 min,
  juste après une commande, et jamais quand elle envoie déjà ses rapports
  (application ouverte) : chaque demande remplace l'abonnement de
  l'application, qui affiche alors la tondeuse déconnectée. La réponse arrive
  en protobuf sur le broker en quelques secondes (`report.js`).
- Avant chaque commande, un « sync » (`DevNet.todev_ble_sync = 3`) réveille la
  liaison cloud de la tondeuse : sans lui, elle ignore les ordres
  (« Device not responding »).
- `src/mammotion/commands.js` + `protobuf.js` : commandes au format protobuf
  (`LubaMsg` → `NavTaskCtrl` : start, pause, resume, stop, dock…). Sauf la
  Luba 1, les tondeuses reçoivent ces commandes sur leur carte de navigation
  (`rcver` = 17). Même chose pour la liste des zones et le trajet.
- `src/mammotion/report.js` : lecture des rapports protobuf (état, batterie,
  charge, hauteur de coupe, avancement, temps restant, compteurs).
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
