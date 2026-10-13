# Mammotion

Controle su robot cortacésped Mammotion (Luba, Luba 2, Luba mini, Yuka…)
desde Gladys: inicie el corte, póngalo en pausa y reanúdelo, envíe el
cortacésped de vuelta a su base y siga su batería, su estado y el progreso
del corte.

## Qué obtiene

Cada cortacésped de su cuenta Mammotion aparece con:

- **Corte** (interruptor): encendido = iniciar una tarea (o reanudar la que
  está en pausa), apagado = pausar;
- **Volver a la base** (interruptor): encendido = volver a la base para
  cargar, apagado = cancelar. Como «Recargar» en la aplicación: una tarea en
  curso queda en pausa, **Corte** la reanuda más tarde;
- **Detener la tarea** (botón): termina la tarea, el cortacésped se queda
  donde está (como «Detener» en la aplicación). **Volver a la base** lo lleva
  después a casa;
- **Actualizar** (botón): pide al cortacésped su estado en ese momento;
- **Estado**: Cortando (45 %), Cargando, En pausa, Volviendo a la base, Sin
  conexión…;
- **Batería** (%) y **Cargando**;
- **Altura de corte** (mm);
- durante una tarea: **Progreso del corte** (%), **Tiempo de corte
  transcurrido** y **restante** (min), **Superficie a cortar** (m²);
- **Tiempo de corte total** (h), **Distancia total** (km);
- **Mapa**: un dispositivo propio, «<cortacésped> – Mapa» (imagen, widget
  **Cámara** del panel): las zonas (verde vivo = zonas de la próxima tarea,
  verde pálido = las demás) con su nombre, las zonas prohibidas (gris) y el
  cortacésped (punto rojo);
- las **zonas de la próxima tarea**: un interruptor «Zona a cortar – …» por
  cada zona del mapa. Puede haber varias zonas encendidas; ninguna encendida =
  todas las zonas. Las zonas se cortan en el orden en que se encienden, como
  en la aplicación;
- los **demás ajustes de la próxima tarea**, «Ajuste – …»: listas para la
  altura de corte, la velocidad, la separación, el tipo de ángulo (óptimo,
  personalizado, aleatorio), el patrón (zigzag, damero, zigzag adaptativo),
  las vueltas al perímetro, la detección de obstáculos, las vueltas a las
  zonas prohibidas (de 0 a 3) y el orden; controles deslizantes para el
  ángulo personalizado (de 0 a 180°, como en la aplicación) y el progreso
  inicial (de 0 a 99 %). Las listas siguen los rangos del modelo: en un
  Luba 2 X, por ejemplo, altura de 25 a 70 mm en pasos de 5, velocidad de 0,2
  a 0,8 m/s, separación de 20 a 35 cm.
- las **zonas sin nombre** en la aplicación se llaman como en la aplicación
  («Zone 1», «Zone 4»…).

> **Ajustes en el dispositivo** (como en la integración Dreame): elija las
> zonas y los valores en las listas del cortacésped (panel o escena) y luego
> encienda **Corte**: la tarea se inicia con esos ajustes.
>
> - Al principio, las listas toman la sección «Nueva tarea de corte» de la
>   configuración.
> - Una elección en una lista solo se aplica a ese cortacésped.
> - Guardar un valor **nuevo** en la configuración lo aplica a todos los
>   cortacéspedes.
> - Los interruptores de zona aparecen una vez leído el mapa (al iniciarse la
>   integración, con el cortacésped encendido), tras **Actualizar** en la
>   pestaña **Descubrir**.

> **Iniciar el corte** desde Gladys (cortacésped «Listo», en su base o no),
> como lo hace Home Assistant:
>
> - una tarea que se detuvo a medias (batería, lluvia…) continúa donde estaba;
> - si no, Gladys planifica una ruta sobre **todas las zonas** del mapa (con
>   nombre o sin él), o sobre las encendidas en «Zona a cortar – …», con los
>   ajustes de la sección «Nueva tarea de corte» de la configuración (altura,
>   velocidad, separación, ángulo, patrón, vueltas al perímetro, detección de
>   obstáculos…), y luego inicia la tarea.
>
> La aplicación Mammotion guarda sus ajustes en el teléfono: Gladys no puede
> leerlos, introdúzcalos en su configuración. Esto funciona con los
> cortacéspedes del broker de Mammotion (Luba 2 recientes, Luba mini, Yuka…),
> no con el Luba 1.

## Configuración

1. Abra la pestaña **Configuración** de la integración.
2. Introduzca el **correo electrónico** y la **contraseña** de su cuenta de la
   aplicación Mammotion.
3. Defina el **intervalo de actualización** (300 s por defecto, entre 30 y
   3600 s): la frecuencia con la que Gladys lee el estado del cortacésped.
   Cada lectura le pide su estado, lo que puede molestar un momento a la
   aplicación Mammotion: mantenga 300 s o más.
4. Guarde y luego pulse **Probar la conexión**: se muestra el número de
   cortacéspedes encontrados.
5. Añada sus cortacéspedes desde la pestaña **Descubrir**. Tras una
   actualización de la integración, pulse **Actualizar** en esta pestaña para
   obtener las nuevas funciones (el botón Actualizar, por ejemplo).

La función **Cargando** **no** está en la categoría batería, a propósito.
Gladys avisa «nivel de batería inferior a X %» para **toda función de la
categoría batería** por debajo del umbral, sea cual sea su tipo: una función
de carga vale 0 o 1, así que se leía como «0 %». En su lugar se publica como
**entrada binaria**: mismo valor sí/no, mismo uso en una escena, sin falsa
alerta.

> Consejo: cree una segunda cuenta Mammotion, compártale el cortacésped desde
> la aplicación y utilice esa cuenta aquí. Si no, la aplicación de su teléfono
> puede cerrar la sesión cuando Gladys se conecta.

> Seguridad: los cortacéspedes recientes informan a través del broker MQTT de
> Mammotion, y su certificado TLS **no se comprueba** (como en la aplicación
> Mammotion y los demás clientes de código abierto: no se sabe que el broker
> presente un certificado que una comprobación estándar acepte). Alguien capaz
> de interceptar el tráfico de su red podría hacerse pasar por el broker y
> leer el token de acceso de corta duración de la cuenta. Una cuenta dedicada
> con solo el cortacésped compartido (consejo anterior) limita lo que
> revelaría.

## Widget, disparadores y acciones de escena (Gladys 5.1)

### Widget «Cortacésped Mammotion»

En **Panel → Editar → Nuevo widget**, elija **Cortacésped Mammotion** y luego
el cortacésped. El widget muestra el estado, la batería, el progreso y el
tiempo restante de la tarea, y los botones que tienen sentido en ese momento:
**Cortar** (o **Reanudar**), **Pausa**, **A la base**. Muestra el último
estado recibido: abrir el panel no envía nada al cortacésped.

### Disparadores

| Disparador                       | Cuándo                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Un cortacésped empieza a cortar  | Una nueva tarea, o una tarea en pausa que se reanuda                             |
| Una tarea de corte termina       | Terminada o detenida (una recarga en medio de una tarea no la termina)           |
| Un cortacésped vuelve a su base  | Empieza a cargar                                                                 |
| Un cortacésped tiene un problema | Sin conexión, error de posición, fuera de zona, bloqueado, actualización fallida |

Cada uno se dispara una vez, con el cambio, nunca cuando se reinicia la
integración. Variables: nombre del cortacésped, estado, batería y, según el
disparador, el progreso, «tarea en pausa para recargar» o el problema.

### Acciones

- **Iniciar el corte**: una nueva tarea con las zonas y ajustes elegidos en
  Gladys, o una tarea en pausa que se reanuda.
- **Pausar el corte**.
- **Enviar un cortacésped a su base** (la tarea queda en pausa).
- **Leer un cortacésped**: estado, en línea, cortando, batería, progreso,
  tiempo restante, problema. Marque «Consultar primero al cortacésped» para
  obtener un valor actualizado.

Las tres primeras devuelven un **resultado** (`started`, `resumed`,
`already_mowing`, `already_starting`, `paused`, `not_mowing`, `returning`,
`already_docked`). Una nueva tarea tarda de 30 a 60 s en iniciarse (zonas,
ruta y luego inicio): otro «Iniciar el corte» mientras tanto, desde una
escena, el widget o el interruptor **Corte**, no inicia nada y responde
`already_starting`.

## Ideas de escenas

- Cortar el césped cada sábado a las 10 h si no llueve.
- El sábado, encender «Zona a cortar – Delante» y «Zona a cortar – Lateral»,
  apagar las demás y luego encender «Corte»; el miércoles, apagarlas todas
  (todas las zonas) y luego encender «Corte».
- Reanudar la tarea en pausa cuando deje de llover.
- Enviar el cortacésped a su base cuando el sensor de lluvia detecte lluvia.
- Recibir un mensaje cuando el cortacésped tenga un problema (disparador «Un
  cortacésped tiene un problema»).
- Recibir un mensaje cuando termine la tarea de corte.

## Solución de problemas

- **No hay listas «Ajuste – …» en el cortacésped**: pestaña **Descubrir**,
  botón **Actualizar** del cortacésped.
- **No hay interruptor «Zona a cortar – …», o el mapa dice «Mapa aún no
  leído»**: el cortacésped todavía no ha enviado su mapa (apagado, sin
  conexión). Se vuelve a leer en el próximo inicio de la integración y con
  cada tarea iniciada desde Gladys. Después, **Actualizar** en la pestaña
  **Descubrir**.
- **Mostrar el mapa**: pestaña **Descubrir**, añada el dispositivo
  «<cortacésped> – Mapa» y luego, en el panel, añada un widget **Cámara** y
  elija ese dispositivo. La imagen sigue al cortacésped durante una tarea
  (como mucho cada 15 s).
- **Comprobar un ajuste de la aplicación**: inicie una tarea desde la
  aplicación Mammotion y luego busque «route settings seen» en los registros
  de la integración. La línea muestra lo que envió la aplicación
  (`towardMode` = tipo de ángulo, `channelMode` = patrón…).

- **«Nube de Mammotion inaccesible»**: compruebe el correo electrónico y la
  contraseña y luego pulse **Probar la conexión**.
- **No se encuentra ningún cortacésped**: asegúrese de que el cortacésped
  aparece en la aplicación Mammotion con esta cuenta (propietario o
  compartido).
- **Los valores no cambian**: pulse **Actualizar** (en el panel) o
  **Actualizar los cortacéspedes ahora** (pestaña Configuración), que lee
  todos los cortacéspedes y nombra los que no pudo leer. Los cortacéspedes
  recientes (broker de Mammotion) envían su estado por sí solos; Gladys les
  pide un informe como mucho cada 5 minutos (y justo después de una orden),
  para respetar la cuota de la nube de Mammotion y no cerrar la sesión de la
  aplicación de su teléfono.
- **El corte no se inicia**: consulte los registros. «The mower did not send
  its zones»: el cortacésped no respondió, inténtelo de nuevo. «Cannot start
  mowing now»: el cortacésped no está listo (volviendo a su base,
  bloqueado…).
- **«El nivel de batería de … es inferior al 20 % (actual: 0 %)»** cuando la
  batería está llena: era la antigua función **Cargando**, clasificada en la
  categoría batería, que vale 0 cuando el cortacésped no está cargando. La
  nueva función **Cargando** es una entrada binaria. La antigua permanece en
  los cortacéspedes añadidos antes: abra la pestaña **Descubrir** y pulse
  **Actualizar** en el cortacésped — Gladys elimina las funciones que ya no se
  publican y la alerta cesa.
- Para más detalles, consulte los registros de la integración con
  `LOG_LEVEL=debug`.
