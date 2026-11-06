import { Repository } from '../packages/storage/src/index.ts';
import { createDoc, insert } from '../packages/model/src/index.ts';

const repo = await Repository.memory();
const doc = createDoc();
insert(doc, { content: { runs: [{ text: 'tomatoes need staking' }] } });
const pageId = repo.createPage({ title: 'Gardening' });
repo.savePage(pageId, doc);

console.log('fts rows:', JSON.stringify(repo.db.prepare('SELECT page_id, title, body FROM fts_block').all()));
const match = '"garden"*';
console.log('MATCH', match, '->', JSON.stringify(
  repo.db.prepare(
    `SELECT f.page_id, p.title, snippet(f, 3, '<', '>', ' ... ', 12) AS snip, bm25(fts_block, 10.0, 1.0) AS rank
     FROM fts_block f JOIN page p ON p.id = f.page_id
     WHERE fts_block MATCH ? AND p.trashed_at IS NULL ORDER BY rank LIMIT ?`,
  ).all(match, 60),
));
console.log('search():', JSON.stringify(repo.search('garden')));
repo.close();