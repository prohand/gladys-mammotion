# Mammotion

Pilotez votre robot tondeuse Mammotion (Luba, Luba 2, Luba mini, Yuka…) depuis
Gladys : lancer la tonte, la mettre en pause, renvoyer la tondeuse à sa base,
et suivre sa batterie et son état.

## Ce que vous obtenez

Chaque tondeuse de votre compte Mammotion apparaît avec :

- **Tonte** (interrupteur) : allumé = lancer ou reprendre la tonte, éteint = pause ;
- **Retour à la base** (interrupteur) : allumé = retour à la base, éteint = annuler ;
- **État** : En tonte, En charge, En pause, Retour à la base, Hors ligne… ;
- **Batterie** (%) et **En charge** ;
- **Hauteur de coupe** (mm), **Temps de tonte total** (h), **Distance totale** (km).

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Saisissez l'**email** et le **mot de passe** de votre compte de
   l'application Mammotion.
3. Réglez l'**intervalle de rafraîchissement** (60 s par défaut, entre 30 et
   3600 s) : c'est la fréquence à laquelle Gladys lit l'état de la tondeuse.
4. Enregistrez puis cliquez sur **Tester la connexion** : le nombre de
   tondeuses trouvées s'affiche.
5. Ajoutez vos tondeuses depuis l'onglet **Découverte**.

> Conseil : créez un second compte Mammotion, partagez-lui la tondeuse depuis
> l'application, et utilisez ce compte ici. Sinon l'application sur votre
> téléphone peut être déconnectée quand Gladys se connecte.

## Exemples de scènes

- Lancer la tonte le samedi à 10 h si la batterie est au-dessus de 80 %.
- Renvoyer la tondeuse à la base quand le capteur de pluie détecte de la pluie.
- Recevoir un message quand l'état passe à « Erreur de position ».

## Dépannage

- **« Cloud Mammotion injoignable »** : vérifiez l'email et le mot de passe,
  puis cliquez sur **Tester la connexion**.
- **Aucune tondeuse trouvée** : vérifiez que la tondeuse apparaît bien dans
  l'application Mammotion avec ce compte (propriétaire ou partage).
- **Les valeurs ne bougent pas** : cliquez sur **Rafraîchir les tondeuses**,
  ou baissez l'intervalle de rafraîchissement.
- Pour plus de détails, consultez les logs de l'intégration avec
  `LOG_LEVEL=debug`.
