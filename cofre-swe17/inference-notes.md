# Notas de inferencia - Crown Chest

La imagen de referencia muestra una única vista 3/4 frontal-izquierda de un cofre estilizado. A continuación se documenta qué partes son observables y qué partes fueron inferidas o aproximadas para la reconstrucción procedural.

## Partes visibles en la referencia

- Cuerpo base con forma de caja rechoncha y bordes redondeados.
- Tapa superior como volumen aparte, también con bordes redondeados.
- Ocho refuerzos metálicos dorados en las esquinas: cuatro en la tapa y cuatro en la base.
- Bisagras doradas en el borde trasero superior.
- Corona frontal luminosa, dorada/blanca.
- Asa lateral izquierda, dorada.
- Gradiente de color púrpura en la parte superior a turquesa en la parte inferior.
- Acabado brillante tipo esmalte en el cuerpo y aspecto metálico dorado en los refuerzos.

## Partes inferidas

- **Trasera del cofre y bisagras traseras inferiores**: no se ven, se asumen simétricas y continuas con la geometría frontal y lateral.
- **Parte inferior y base del cofre**: la referencia está recortada justo por debajo del cofre; se asume una base plana continua que se apoya sobre el plano del suelo.
- **Interior del cofre**: no es visible; no se modela. La tapa puede abrirse pero no hay interior.
- **Espesor de la tapa y la pared del cofre**: se inferen como cajas macizas con radio de redondeo uniforme, no se modelan paredes delgadas.
- **Asa derecha**: la referencia solo muestra una asa en el lado izquierdo. Se asume que el lado derecho también podría llevarla, pero por simetría de la referencia se modela únicamente la asa lateral izquierda visible.
- **Geometría exacta de las bisagras**: solo se ve la parte superior trasera; se aproximan por cilindros decorativos.
- **Gradiente en caras ocultas**: se aplica un gradiente vertical continuo en todos los vértices; la distribución exacta en caras no vistas es una extrapolación consistente.

## Aproximaciones estilizadas

- La corona es una extrusión procedural 2D con picos redondeados, separada en un borde dorado metálico y un relleno amarillo brillante (`MeshBasicMaterial`) para simular el icono luminoso.
- Los refuerzos son cajas con esquinas redondeadas y remaches cilíndricos oscuros en cada cara visible, en lugar de las formas facetadas/agujereadas exactas de la referencia.
- El asa lateral se construye con cilindros rectangulares en lugar de un toroide continuo.
- El brillo de esmalte se aproxima con `MeshPhysicalMaterial` (clearcoat alto, rugosidad baja) y un mapa de entorno `RoomEnvironment`.
- La corona luminosa se acompaña de una luz puntual sutil que ilumina el cuerpo para sugerir un resplandor.

## Estado de la comparación

- La silueta general, la relación tapa/cuerpo, el gradiente púrpura-turquesa, la ubicación de refuerzos, la corona frontal y el asa lateral coinciden a nivel estilizado.
- Las diferencias restantes son: la forma más facetada/achaflanada de los refuerzos en la referencia, el brillo más intenso y difuso de la corona en la referencia, y el ángulo de cámara ligeramente distinto.
