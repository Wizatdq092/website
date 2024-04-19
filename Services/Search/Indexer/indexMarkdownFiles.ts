import fs from 'fs';
import path from 'path';
import { remark } from 'remark';
import html from 'remark-html';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParseFrontmatter from 'remark-parse-frontmatter';
import MeiliSearch from 'meilisearch';

import type { Index, Config } from 'meilisearch';

const sleep = (timeout: number) => {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), timeout);
  });
}

async function waitForTask(client: MeiliSearch, id: number) {
  while (true) {
    const status = await client.getTask(id);
    if (status.error) throw new Error(status.error.message);
    if (status.status !== 'processing') break;
    await sleep(1000);
  }
}

const filterMdFiles = (filePaths: string[]) => {
 return filePaths.filter(filePath => {
    const extension = path.extname(filePath);
    return extension === '.md' || extension === '.mdx';
 });
}

const listFilesRecursively = ({
  directory,
  fileList = [],
}: {
  directory: string;
  fileList?: string[];
}) => {
 const files = fs.readdirSync(directory);

 files.forEach(file => {
    const filePath = path.join(directory, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      listFilesRecursively({
        directory: filePath,
        fileList,
      });
    } else {
      fileList.push(filePath);
    }
 });

 return fileList;
}

const toSlug = (name: string) => {
 let text = name.toLowerCase();
 text = text.replace(/[^a-z0-9\s]/g, '');
 text = text.replace(/\s+/g, '-');
 text = text.trim();

 return text;
}

export default async ({
  host,
  indexName,
}: {
  host: string;
  indexName: string;
}) => {
  const apiKey = process.env.PRIVATE_MEILISEARCH_DOCUMENTS_ADMIN_API_KEY;

  if (!apiKey) throw Error("👹 Oops! Missing admin api key...");

  const client = new MeiliSearch({
    host,
    apiKey,
  } as Config);

  let index: Index | undefined = undefined;

  try {
    index = await client.getIndex(indexName);
    console.log(`✅ Found index ${indexName}`);
  } catch (e) {
    console.log(`⚠️ The index ${indexName} doesn't exist.`)
  }

  if (!index) {
    try {
      const task = await client.createIndex(indexName);
      await waitForTask(client, task.taskUid);     
      
      index = await client.getIndex(indexName);
      console.log(`✅ Created index ${indexName}`);
    } catch (e) {
      console.error('👹 Oops! Failed to create index:', e);
      process.exit(1);
    }    
  }

  return async ({
    targetDir,
  }: {
      targetDir: string;
  }) => {   
    let files = listFilesRecursively({
      directory: targetDir,
    });

    files = filterMdFiles(files);

    for (const filePath of files) {
     
      const fileContent = fs.readFileSync(filePath, 'utf-8');

      const processedContent = await remark()
        .use(html)
        .process(fileContent);

      const parsed = await remark()
        .use(remarkFrontmatter)
        .use(remarkParseFrontmatter)
        .process(fileContent);

      const { title, category, date, desc } = parsed.data.frontmatter as Record<string, string>;

      const content = processedContent.toString();

      try {
        // TODO: Change to addDocuments in batches
        // client.index('myIndex').addDocumentsInBatches(documents: Document<T>[], batchSize = 1000): Promise<EnqueuedTask[]>
        const task = await index.addDocuments([{
          id: toSlug(`${category}-${title}`),
          content,
          title,
          category,
          date,
          desc,
        }]);

        // TODO: this should be removed as its only used for debugging at the moment  
        await waitForTask(client, task.taskUid);

        console.log(`✅ Added document ${filePath}`);
      } catch (e) {
        console.error(`👹 Oops! Error indexing ${filePath}:`, e);
      }
    }
  }
}