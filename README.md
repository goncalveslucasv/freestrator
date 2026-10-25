# Freestrator

Editor vectorial web al estilo Adobe Illustrator, hecho con Next.js + React, que **abre, edita y guarda archivos `.ai`** directamente en el navegador (el archivo no sale de tu computadora).

```bash
npm install
npm run dev        # http://localhost:3000
```

Abrí un `.ai` con **Archivo › Abrir…** (⌘O) o arrastrándolo a la ventana.

## Qué se puede hacer

- **Abrir** `.ai` compatibles con PDF (la opción por defecto de Illustrator desde CS) y PDF. Cada mesa de trabajo se convierte en una página; las capas (OCG) se conservan. Los archivos grandes se leen por rangos, así que uno de 650 MB abre en segundos.
- **Ver** con alta fidelidad: trazados, grupos de recorte, máscaras de opacidad (luminosidad), modos de fusión, degradados lineales/radiales, degradados de malla, imágenes, texto con su fuente embebida y gestión de color ICC (por ejemplo, documentos Adobe RGB).
- **Editar**:
  - Herramientas: Selección (V), Selección directa (A), Pluma (P), Texto (T), Línea (\\), Rectángulo (M), Elipse (L), Cuentagotas (I), Mano (H / Espacio), Zoom (Z).
  - Mover, escalar (⇧ proporcional, ⌥ desde el centro), rotar (cerca de las esquinas; ⇧ de a 15°), reflejar, alinear, organizar, agrupar, máscaras de recorte, duplicar con ⌥+arrastrar.
  - Editar nodos y manejadores de curvas con la Selección directa.
  - Doble clic para entrar a un grupo (modo aislamiento) o editar un texto. El texto editado sigue usando la fuente embebida del archivo para los caracteres que contiene y completa el resto con la misma familia desde Google Fonts.
  - Panel de propiedades: posición/tamaño, relleno y trazo (sólido o degradado, con paradas editables), grosor, opacidad, modo de fusión, carácter (fuente, tamaño, tracking), reemplazar imagen.
  - Panel de capas: visibilidad, bloqueo, renombrar (doble clic), reordenar arrastrando.
  - Deshacer/rehacer (⌘Z / ⇧⌘Z), copiar/cortar/pegar, pegar en el lugar.
- **Guardar** como `.ai` (⌘S): un PDF multipágina con capas que Illustrator abre como archivo compatible con PDF. También exporta PDF, SVG y PNG (300 ppp) de la mesa activa.

## Cómo funciona

| Módulo | Rol |
| --- | --- |
| `src/lib/importer.ts` | Carga el `.ai` con pdf.js e **interpreta su lista de operadores** (save/restore, CTM, clips, grupos de transparencia, máscaras suaves, shadings, imágenes, texto) para construir un árbol de escena editable. Luego simplifica el árbol (quita recortes redundantes, convierte "recorte + shading" en una forma con degradado, aplana grupos vacíos). |
| `src/lib/types.ts` | Modelo de escena: capas › subcapas por mesa › grupos / trazados / imágenes / textos. Toda la geometría está en espacio de documento (pt, y hacia abajo). |
| `src/lib/render.tsx` | Render SVG de la escena, compartido entre el lienzo y la exportación SVG/PNG. |
| `src/lib/store.ts`, `ops.ts`, `actions.ts` | Estado (zustand + immer, historial con fusión de cambios continuos), operaciones sobre el árbol y comandos del editor. |
| `src/components/` | Interfaz: lienzo con herramientas y manijas, barra de herramientas, paneles de propiedades, capas y mesas de trabajo, menús. |
| `src/lib/exportPdf.ts` | Escribe el PDF/.ai con pdf-lib: streams de contenido propios, shadings, máscaras de luminosidad, grupos de transparencia, fuentes embebidas (TJ con las posiciones originales) y capas como contenido opcional. |

## Limitaciones conocidas

- Los `.ai` guardados **sin** "Crear archivo compatible con PDF" (o en formato PostScript anterior a CS) no traen una versión PDF y no se pueden abrir.
- Los datos privados de Illustrator (efectos en vivo, símbolos, estilos de texto de área, etc.) no se leen: se edita el arte tal como se ve. Al guardar, Illustrator abre el archivo como PDF.
- Los degradados de malla se rasterizan al importar.
- Los colores se convierten a sRGB al abrir (según el perfil ICC del documento) y se guardan en RGB.
