# Mammotion

Pilotez votre robot tondeuse Mammotion (Luba, Luba 2, Luba mini, Yuka…) depuis
Gladys : lancer une tonte, la mettre en pause et la reprendre, renvoyer la
tondeuse à sa base, et suivre sa batterie, son état et l'avancement de la tonte.

## Ce que vous obtenez

Chaque tondeuse de votre compte Mammotion apparaît avec :

- **Tonte** (interrupteur) : allumé = lancer une tonte (ou reprendre celle en
  pause), éteint = pause ;
- **Retour à la base** (interrupteur) : allumé = retour à la base, éteint = annuler ;
- **Rafraîchir** (bouton) : demande tout de suite son état à la tondeuse ;
- **État** : En tonte (45 %), En charge, En pause, Retour à la base, Hors ligne… ;
- **Batterie** (%) et **En charge** ;
- **Hauteur de coupe** (mm), **Temps de tonte restant** (min) ;
- **Temps de tonte total** (h), **Distance totale** (km).

> **Lancer une tonte** depuis Gladys (tondeuse « Prête », sur sa base ou non),
> comme le fait Home Assistant :
>
> - si une tonte s'est arrêtée en cours (batterie, pluie…), elle reprend là où
>   elle en était ;
> - sinon, Gladys prépare un trajet sur **toutes les zones** de la carte, avec
>   la hauteur de coupe actuelle et les réglages par défaut (1 tour de
>   bordure, 25 cm entre les passages, 0,3 m/s, détection d'obstacles), puis
>   lance la tonte.
>
> Pour tondre une seule zone ou changer les réglages, passez encore par
> l'application. Cette fonction marche avec les tondeuses du broker Mammotion
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
   obtenir les nouvelles fonctionnalités (par exemple le bouton Rafraîchir).

> Conseil : créez un second compte Mammotion, partagez-lui la tondeuse depuis
> l'application, et utilisez ce compte ici. Sinon l'application sur votre
> téléphone peut être déconnectée quand Gladys se connecte.

## Exemples de scènes

- Lancer une tonte chaque samedi à 10 h s'il ne pleut pas.
- Reprendre la tonte en pause quand la pluie s'arrête.
- Renvoyer la tondeuse à la base quand le capteur de pluie détecte de la pluie.
- Recevoir un message quand l'état passe à « Erreur de position ».

## Dépannage

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
- Pour plus de détails, consultez les logs de l'intégration avec
  `LOG_LEVEL=debug`.
