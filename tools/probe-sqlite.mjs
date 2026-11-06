import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec('CREATE VIRTUAL TABLE t USING fts5(x, tokenize="unicode61")');
db.exec("INSERT INTO t(x) VALUES('hello world')");
db.exec("INSERT INTO t(x) VALUES('goodbye')");
db.exec("INSERT INTO t(x) VALUES('HELLO there')");
console.log('prefix hel* ->', JSON.stringify(db.prepare("SELECT x FROM t WHERE t MATCH ?").all('hel*')));
console.log('exact  hello ->', JSON.stringify(db.prepare("SELECT x FROM t WHERE t MATCH ?").all('hello')));
console.log('bm25 ->', JSON.stringify(db.prepare("SELECT x, bm25(t) as rank FROM t WHERE t MATCH ? ORDER BY rank").all('hello')));
console.log('highlight ->', JSON.stringify(db.prepare("SELECT highlight(t,0,'[',']') h FROM t WHERE t MATCH ?").all('hello')));
db.close();