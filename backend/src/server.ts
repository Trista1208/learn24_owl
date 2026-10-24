import { createApp } from './app.ts';
import { content } from './content.ts';
import { providerName } from './provider.ts';

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`Learning agent on http://localhost:${port}`);
  console.log(`Content: ${content.lessons.length} lessons in ${content.skills.flatMap((s) => s.tracks).length} tracks`);
  const provider = providerName();
  console.log(provider === 'none' ? 'Model: none configured -> prepared content (“Without AI” mode)' : `Model: ${provider}`);
});
