# freestrator-mcp

Servidor [MCP](https://modelcontextprotocol.io) para [Freestrator](https://freestrator.vercel.app). Le permite a Claude:

- dibujar escribiendo SVG,
- vectorizar fotos e imágenes,
- comparar su dibujo con la imagen original,
- guardar el resultado en `.ai`.

Si abrís el editor web y lo conectás, ves cada cambio en vivo, y lo que editás a mano también le llega a Claude.

```
Claude ──stdio──▶ freestrator-mcp (en tu computadora) ◀──WebSocket 127.0.0.1:7465──▶ freestrator.vercel.app (tu navegador)
```

El servidor corre en tu computadora. El editor web se conecta directamente a él, así que tus archivos no pasan por ningún servidor externo.

## Instalación

Requiere Node.js 20 o superior.

**Claude Code**

```bash
claude mcp add freestrator -- npx -y freestrator-mcp
```

**Claude Desktop**: abrí Configuración › Desarrollador › Editar configuración y agregá esto:

```json
{
  "mcpServers": {
    "freestrator": {
      "command": "npx",
      "args": ["-y", "freestrator-mcp"]
    }
  }
}
```

Reiniciá Claude después de instalarlo.

## Conectar el editor (opcional)

1. Abrí https://freestrator.vercel.app.
2. Andá a **Claude › Conectar con Claude…** y apretá **Conectar**.
3. Chrome y Edge te van a pedir permiso para acceder a **apps de este dispositivo** (red local). Aceptalo: es la conexión con el servidor de tu computadora. Si lo rechazaste, lo podés reactivar desde el candado de la barra de direcciones.

La barra de estado muestra «● Claude conectado». La opción queda guardada y el editor se reconecta solo.

Cómo se sincronizan los documentos:
- Si el editor tiene un documento abierto al conectarse, ese documento pasa a Claude.
- Si el editor está vacío, recibe el documento de Claude.
- Después de eso, cada cambio de un lado llega al otro, y los cambios de Claude se deshacen con ⌘Z como cualquier otro.

## Uso

Pedile a Claude algo como:

> Usá Freestrator para vectorizar ~/Desktop/logo.png. Quiero formas limpias. Guardalo en ~/Desktop/logo.ai

Si en Claude Desktop pegaste la imagen en el chat, el servidor no puede leer esos bytes. En ese caso, colocala vos desde el editor con **Claude › Colocar imagen de referencia…**.

## Tools

| Tool | Qué hace |
| --- | --- |
| `get_document` | Mesas de trabajo, referencia, selección del editor y árbol de objetos (ids, bbox, colores) |
| `new_document` | Documento vacío de W×H pt |
| `set_reference` | Foto de referencia desde una ruta o una URL; va en una capa bloqueada que no se exporta |
| `vectorize` | Vectorizado determinista de la referencia (ver abajo) |
| `add_svg` | Dibuja SVG: path (con arcos), rect, circle, ellipse, line, poly*, g, text, use, degradados, clip-path, `<style>`. Admite `parent_id` y `replace_id` |
| `update_nodes` | Nombre, relleno, trazo, opacidad, visibilidad, bloqueo, `d`, transform, texto |
| `delete_nodes` / `group_nodes` / `arrange_nodes` | Estructura del documento |
| `get_svg` | Devuelve objetos como SVG en coordenadas del documento, para leerlos y reescribirlos |
| `render` / `compare` | Ver el resultado; comparar con la referencia (mapa de error y zonas que fallan) |
| `undo` | Deshace pasos (los de Claude y los del editor) |
| `save` | Guarda en `.ai`, `.pdf`, `.svg` o `.png` |

## Vectorizado

Es el mismo algoritmo que usa **Objeto › Vectorizar imagen…** en el editor. No usa IA: la misma imagen con las mismas opciones da siempre el mismo resultado.

1. **Paleta que ignora el antialiasing.** Los colores salen sobre todo de las zonas planas. Los colores de borde que son mezcla de dos vecinos, o ringing de compresión, se descartan. Cada píxel de borde se asigna al color de uno de sus lados, y por eso no quedan halos.
2. **Limpieza.** Se eliminan las manchas chicas y las franjas finas de bajo contraste. Los detalles de alto contraste, como letras, ojos o puntos, se conservan. En el nivel `low` se aplica además una mediana adaptativa.
3. **Regiones.** Cada zona de color se convierte en una forma con sus huecos rellenos, y las formas se apilan según cómo se anidan. Cada forma se extiende 1 px por debajo de las vecinas que se dibujan encima, así no quedan rendijas.
4. **Figuras exactas.** Los contornos que son rectángulos, rectángulos redondeados o elipses se reemplazan por la figura exacta. El resto se traza con curvas Bézier, usando detección de esquinas y ajuste por mínimos cuadrados (algoritmo de Schneider).
5. **Texto (`ocr: true`).** Usa tesseract.js, que corre localmente; la primera vez descarga unos 10 MB de datos de idioma. Las líneas que se reconocen con confianza se convierten en texto editable y se borran del trazado. El texto dudoso queda trazado como forma.

Niveles de detalle:
- `low`: logos e íconos.
- `medium`: ilustraciones e infografías.
- `high`: imágenes con mucho detalle.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `FREESTRATOR_BRIDGE_PORT` | Puerto del puente con el editor (7465 por defecto; el editor web usa 7465) |
| `FREESTRATOR_ALLOWED_ORIGINS` | Otros orígenes que pueden conectarse al puente, separados por coma. Por defecto solo se aceptan `https://freestrator.vercel.app` y `localhost` |

Si abrís dos sesiones de Claude, la segunda no puede usar el puerto del puente. Funciona igual, pero sin conexión con el editor.

## Desarrollo

Desde la raíz del repo:

```bash
npm install
npm run dev          # editor en http://localhost:3000
npm run mcp          # servidor MCP desde el código fuente (lo usa el .mcp.json del repo)
npm run mcp:build    # genera mcp/dist/server.mjs para publicar
cd mcp && npm publish
```

`mcp/server.ts` comparte con el editor el código de `src/lib`: modelo, render, exportación a PDF/.ai, importador SVG y vectorizador.
