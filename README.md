# Escapadas en coche

App web personal para planear salidas de un día en coche por la Comunitat Valenciana: sitios a 90 minutos como mucho, rutas por carreteras secundarias que se abren en Google Maps y Android Auto, tiempo previsto, sitios para comer, historial de visitas y fotos en Nextcloud.

## Qué hace

- **Planear:** eliges sábado, domingo u otro día, desde dónde sales (Aldaia o tu ubicación), qué te apetece hacer (senderismo corto, baño, monumentos, pueblo, mirador…) y el tiempo máximo en coche. Ordena los sitios según la época del año, la previsión para ese día y si ya has ido.
- **Temporada:** avisa de lo que no va bien en esa fecha. Por ejemplo, baño fuera del verano, riesgo de nieve o hielo en invierno, cierres con nivel 3 de incendios en verano, o nieve y lluvia previstas.
- **Ruta:** botones «Ida en Maps», «Vuelta en Maps» y «Ruta completa», que salen desde donde estés. La ida suele empezar con un tramo de autovía y luego va por secundarias.
- **Ficha de cada sitio:** fotos y resumen de Wikipedia, qué ver, tasas y regulaciones, tiempo previsto, y un botón que busca bares, restaurantes y merenderos cerca (OpenStreetMap).
- **Visitas:** «He estado aquí» guarda la fecha, los km, una valoración y notas. Las fotos se suben a Nextcloud, a `Escapadas/<Municipio> - <Lugar>/`.
- **Mapa** con todos los sitios (en verde los visitados) y **estadísticas** del año (escapadas y km).

Funciona sin cobertura con los datos guardados, pero sin tiempos reales, previsión ni fotos.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html`, `app.js` | La app |
| `sitios.json` | La base de datos (43 sitios). Se puede ampliar editándolo |
| `sw.js`, `manifest.webmanifest`, `icon*` | Para instalarla en el móvil y que funcione sin conexión |

## Publicarla en GitHub Pages

1. Crea un repositorio, por ejemplo `Bhelma/Escapadas`, y sube estos archivos a la raíz.
2. En *Settings → Pages*, elige *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. Abre `https://bhelma.github.io/Escapadas/` en el móvil y, en el menú de Chrome, pulsa *Añadir a pantalla de inicio*.

## Conectar Nextcloud (fotos e historial)

La app funciona en `https://bhelma.github.io` y habla con tu Nextcloud por WebDAV. Hacen falta tres cosas:

1. **Nextcloud por HTTPS dentro de Tailscale.** En el NUC, `tailscale serve` publica Nextcloud con certificado en `https://<nombre-del-nuc>.<tu-tailnet>.ts.net`. Añade ese nombre a `trusted_domains` en `config.php`. Sin https el navegador bloquea la conexión.
2. **Permitir esta web (CORS).** Nextcloud no deja, de serie, que otra web use su WebDAV. Instala la app **WebAppPassword** desde la tienda de apps de Nextcloud y añade `https://bhelma.github.io` como origen permitido en sus ajustes.
3. **Contraseña de aplicación.** En Nextcloud, *Ajustes personales → Seguridad → Crear nueva contraseña de aplicación*. Pon esa contraseña en *Ajustes* de la app, junto con la dirección y tu usuario. Pulsa «Probar conexión».

El historial se guarda en `Escapadas/escapadas-visitas.json` y también en el móvil. Si Nextcloud no responde, se sube en la siguiente sincronización. En *Ajustes* también puedes descargar o cargar el historial a mano.

## Servicios que usa (gratuitos, sin clave)

- Tiempos en coche: OSRM (servidor público de OpenStreetMap)
- Previsión: Open-Meteo (hasta 16 días)
- Fotos y textos: Wikipedia y Wikimedia Commons (licencias libres)
- Bares y merenderos cercanos: Overpass (OpenStreetMap)
- Nivel de incendios: enlace al PDF diario del 112 CV (se actualiza sobre las 17:00)
- Carreteras: enlace al mapa de incidencias de la DGT
