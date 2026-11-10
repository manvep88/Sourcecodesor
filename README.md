# SORITICKET 1.3.13

## Corrección de equivalencia entre visor y PDF

El PDF ahora se rasteriza desde el mismo elemento `receiptElement()` y las mismas reglas CSS que utiliza la vista previa. Se elimina el segundo dibujado vectorial independiente, que tenía tamaños tipográficos, espacios, alineaciones y proporciones diferentes.

- Mismo encabezado, logotipo, sucursal, dirección, metadatos, tabla, subtotal/impuestos, total, textos y código de barras.
- Ancho de página de 80 mm y altura variable según el contenido real del ticket.
- Renderizado a 3x antes de incrustarse en el PDF para conservar legibilidad.
- Exportación individual y exportación ZIP usan el mismo generador asíncrono.
- El capturador, catálogo y esquema no cambian en esta versión.

La validación automatizada se realiza con datos simulados en Chromium; no equivale a una prueba en portal Soriana ni en impresora física.
