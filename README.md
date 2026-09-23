# The King Shop

## Qué es esta carpeta

Es tu app ya armada como un proyecto real, lista para correr en una computadora
o subirse a un hosting (Vercel). Por dentro sigue usando los datos de "demo"
por ahora — conectar cada parte a tus tablas de Supabase es el siguiente paso,
que vamos haciendo poco a poco.

## Probarla en tu computadora (opcional)

Necesitas tener [Node.js](https://nodejs.org) instalado. Luego, en una
terminal, dentro de esta carpeta:

```
npm install
npm run dev
```

Te va a dar un link (normalmente `http://localhost:5173`) — ábrelo en tu
navegador para ver la app funcionando.

## Publicarla en Vercel

1. Crea una cuenta en [vercel.com](https://vercel.com) si no tienes.
2. Sube esta carpeta a un repositorio de GitHub, o arrástrala directo en
   Vercel si te da esa opción.
3. En la configuración del proyecto en Vercel, ve a **Environment Variables**
   y agrega estas dos (los mismos valores que están en el archivo `.env` de
   esta carpeta — ese archivo no se sube a Vercel automáticamente, por eso
   hay que ponerlas ahí a mano):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Dale **Deploy**.

## Nunca subas a ningún lado

El archivo `.env` de esta carpeta trae tu URL y llave pública de Supabase —
la llave en sí es segura de compartir (está protegida por las reglas RLS que
ya activamos), pero de cualquier forma no hace falta subir ese archivo a
GitHub; en Vercel se configuran aparte como se explica arriba. 
