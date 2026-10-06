# Mammotion

Pilotez votre robot tondeuse Mammotion (Luba, Luba 2, Luba mini, Yuka…) depuis
Gladys : lancer une tonte, la mettre en pause et la reprendre, renvoyer la
tondeuse à sa base, et suivre sa batterie, son état et l'avancement de la tonte.

## Ce que vous obtenez

Chaque tondeuse de votre compte Mammotion apparaît avec :

- **Tonte** (interrupteur) : allumé = lancer une tonte (ou reprendre celle en
  pause), éteint = pause ;
- **Retour à la base** (interrupteur) : allumé = retour à la base, éteint =
  annuler. Sur une tonte en cours ou en pause, la tonte est d'abord arrêtée (comme
  « Arrêter » dans l'application), sinon elle resterait en pause ;
- **Rafraîchir** (bouton) : demande tout de suite son état à la tondeuse ;
- **État** : En tonte (45 %), En charge, En pause, Retour à la base, Hors ligne… ;
- **Batterie** (%) et **En charge** ;
- **Hauteur de coupe** (mm) ;
- pendant une tonte : **Avancement de la tonte** (%), **Temps de tonte
  écoulé** et **restant** (min), **Surface à tondre** (m²) ;
- **Temps de tonte total** (h), **Distance totale** (km) ;
- **Carte** : un appareil à part, « <tondeuse> – Carte » (image, widget
  **Caméra** du tableau de bord) : les zones (vert vif = zones de la
  prochaine tonte, vert pâle = les autres) avec leur nom, les zones
  interdites (gris) et la tondeuse (point rouge) ;
- les **zones de la prochaine tonte** : un interrupteur « Zone à tondre – … »
  par zone de la carte. Plusieurs zones peuvent être allumées ; aucune
  allumée = toutes les zones. Les zones sont tondues dans l'ordre où on les
  allume, comme dans l'appli ;
- les **autres réglages de la prochaine tonte**, « Réglage – … » : en listes
  pour la hauteur de coupe, la vitesse, l'espacement, le type d'angle
  (optimal, personnaliser, aléatoire), le mode de trajectoire (zigzag, damier,
  zigzag adaptatif), les tours de périmètre, la détection d'obstacle, les tours
  des zones interdites (0 à 3) et l'ordre ; en curseurs pour l'angle
  personnalisé (0 à 180°, comme dans l'appli) et la progression du démarrage
  (0 à 99 %). Les listes suivent les plages du modèle : par exemple sur une
  Luba 2 X, hauteur de 25 à 70 mm par pas de 5, vitesse de 0,2 à 0,8 m/s,
  espacement de 20 à 35 cm.
- les **zones sans nom** dans l'appli s'appellent comme dans l'appli
  (« Zone 1 », « Zone 4 »…).

> **Réglages sur l'appareil** (comme l'intégration Dreame) : choisissez les
> zones et les valeurs dans les listes de la tondeuse (tableau de bord ou
> scène), puis allumez **Tonte** : la tonte part avec ces réglages.
>
> - Au départ, les listes reprennent la section « Nouvelle tonte » de la
>   configuration.
> - Un choix dans une liste vaut pour cette tondeuse seulement.
> - Enregistrer une **nouvelle** valeur dans la configuration l'applique à
>   toutes les tondeuses.
> - Les interrupteurs de zones apparaissent quand la carte est lue (au
>   démarrage de l'intégration, tondeuse allumée), après **Mettre à jour**
>   dans l'onglet **Découverte**.

> **Lancer une tonte** depuis Gladys (tondeuse « Prête », sur sa base ou non),
> comme le fait Home Assistant :
>
> - si une tonte s'est arrêtée en cours (batterie, pluie…), elle reprend là où
>   elle en était ;
> - sinon, Gladys prépare un trajet sur **toutes les zones** de la carte (même
>   celles sans nom), ou sur celles allumées dans « Zone à tondre – … », avec les
>   réglages de la section « Nouvelle tonte » de la configuration (hauteur,
>   vitesse, espacement, angle, mode de trajectoire, tours de périmètre,
>   détection d'obstacle…), puis lance la tonte.
>
> L'application Mammotion garde ses réglages dans le téléphone : Gladys ne
> peut pas les lire, renseignez-les dans sa configuration. Cette fonction marche avec les tondeuses du broker Mammotion
> (Luba 2, Luba mini, Yuka… récentes), pas avec la Luba 1.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Saisissez l'**email** et le **mot de passe** de votre compte de
   l'application Mammotion.
3. Réglez l'**intervalle de rafraîchissement** (300 s par défaut, entre 30 et
   3600 s) : c'est la fréquence à laquelle Gladys lit l'état de la tondeuse.
   Chaque lecture demande son état à la tondeuse, ce qui peut gêner un
   instant l'application Mammotion : gardez 300 s ou plus.
4. Enregistrez puis cliquez sur **Tester la connexion** : le nombre de
   tondeuses trouvées s'affiche.
5. Ajoutez vos tondeuses depuis l'onglet **Découverte**. Après une mise à
   jour de l'intégration, cliquez sur **Mettre à jour** dans cet onglet pour
   obtenir les nouvelles fonctionnalités (par exemple les listes de
   réglages).

La mesure « En charge » n'est volontairement **pas** dans la catégorie
batterie. Gladys prévient « niveau de batterie inférieur à X % » pour **toute
mesure de la catégorie batterie** sous le seuil, quel que soit son type : une
mesure de charge vaut 0 ou 1, elle était donc lue comme « 0 % ». Elle est
publiée comme une **entrée binaire** : même valeur oui/non, même usage dans
une scène, sans fausse alerte.

> Conseil : créez un second compte Mammotion, partagez-lui la tondeuse depuis
> l'application, et utilisez ce compte ici. Sinon l'application sur votre
> téléphone peut être déconnectée quand Gladys se connecte.

## Exemples de scènes

- Lancer une tonte chaque samedi à 10 h s'il ne pleut pas.
- Le samedi, allumer « Zone à tondre – Devant » et « Zone à tondre – Côté »,
  éteindre les autres, puis allumer « Tonte » ; le mercredi, tout éteindre
  (toutes les zones) puis allumer « Tonte ».
- Reprendre la tonte en pause quand la pluie s'arrête.
- Renvoyer la tondeuse à la base quand le capteur de pluie détecte de la pluie.
- Recevoir un message quand l'état passe à « Erreur de position ».

## Dépannage

- **Pas de listes « Réglage – … » sur la tondeuse** : onglet **Découverte**,
  bouton **Mettre à jour** sur la tondeuse.
- **Pas d'interrupteur « Zone à tondre – … », ou la carte affiche « Carte pas
  encore lue »** : la tondeuse n'a pas encore envoyé sa carte (éteinte, hors
  réseau). Elle est relue au prochain démarrage de l'intégration et à chaque
  tonte lancée par Gladys. Puis **Mettre à jour** dans l'onglet
  **Découverte**.
- **Afficher la carte** : onglet **Découverte**, ajoutez l'appareil
  « <tondeuse> – Carte », puis sur le tableau de bord ajoutez un widget
  **Caméra** et choisissez cet appareil. L'image suit la tondeuse pendant la
  tonte (au plus toutes les 15 s).
- **Vérifier un réglage de l'application** : lancez une tonte depuis
  l'application Mammotion, puis cherchez « route settings seen » dans les
  logs de l'intégration. La ligne montre ce que l'application a envoyé
  (`towardMode` = type d'angle, `channelMode` = mode de trajectoire…).

- **« Cloud Mammotion injoignable »** : vérifiez l'email et le mot de passe,
  puis cliquez sur **Tester la connexion**.
- **Aucune tondeuse trouvée** : vérifiez que la tondeuse apparaît bien dans
  l'application Mammotion avec ce compte (propriétaire ou partage).
- **Les valeurs ne bougent pas** : appuyez sur **Rafraîchir** (sur le tableau
  de bord) ou sur **Rafraîchir les tondeuses** (onglet Configuration).
  Les tondeuses récentes (broker Mammotion) envoient leur état d'elles-mêmes ;
  Gladys ne leur demande un rapport qu'au plus toutes les 5 minutes (et juste
  après une commande), pour ne pas dépasser le quota du cloud Mammotion ni
  couper l'application sur votre téléphone.
- **La tonte ne démarre pas** : regardez les logs. « The mower did not send
  its zones » : la tondeuse n'a pas répondu, réessayez. « Cannot start mowing
  now » : la tondeuse n'est pas prête (en retour à la base, verrouillée…).
- **« Le niveau de la batterie de … est inférieur à 20 % (actuel : 0 %) »**
  alors que la batterie est pleine : c'était l'ancienne mesure « En charge »,
  rangée dans la catégorie batterie, qui vaut 0 quand la tondeuse n'est pas en
  charge. La nouvelle mesure « En charge » est une entrée binaire. L'ancienne
  reste enregistrée sur les tondeuses ajoutées avant : ouvrez l'onglet
  **Découverte** et cliquez sur **Mettre à jour** sur la tondeuse — Gladys
  supprime les mesures qui ne sont plus publiées, et l'alerte s'arrête.
- Pour plus de détails, consultez les logs de l'intégration avec
  `LOG_LEVEL=debug`.
