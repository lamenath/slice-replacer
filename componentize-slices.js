// componentize-slices.js

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(`${question}: `, answer => resolve(answer.trim())));
}

async function fetchDocById(repo, id) {
  const apiRoot = `https://${repo}.cdn.prismic.io/api/v2`;
  const rootRes = await fetch(apiRoot);
  const rootData = await rootRes.json();
  const ref = rootData.refs.find(r => r.id === 'master').ref;

  const queryUrl = `https://${repo}.cdn.prismic.io/api/v2/documents/search?ref=${ref}&lang=*&q=[[at(document.id,\"${id}\")]]`;
  const res = await fetch(queryUrl);
  if (!res.ok) throw new Error(`Failed to fetch document ${id}`);
  const data = await res.json();
  return data.results[0];
}

function getMatchingAlternates(alternates, langPrefix) {
  return alternates.filter(alt => alt.lang.startsWith(`${langPrefix}-`));
}

function countSlices(doc, targetSliceId) {
  return doc.data.slices.filter(s => s.slice_type === targetSliceId).length;
}

function summarizeSharedDoc(sharedDoc) {
  return sharedDoc.data.slices.map(s => {
    const preview = Object.entries(s.primary || {}).slice(0, 3).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    return `slice_type: ${s.slice_type} | ${preview}`;
  }).join('\n');
}

function extractSharedSectionRef(sharedDoc) {
  return {
    id: sharedDoc.id,
    type: sharedDoc.type,
    tags: sharedDoc.tags,
    lang: sharedDoc.lang,
    slug: sharedDoc.slugs[0],
    first_publication_date: sharedDoc.first_publication_date,
    last_publication_date: sharedDoc.last_publication_date,
    uid: sharedDoc.uid,
    link_type: 'Document',
    key: sharedDoc.id,
    isBroken: false
  };
}

function replaceSlices(doc, targetSliceId, sharedSectionRef) {
  const updatedSlices = doc.data.slices.map(slice => {
    if (slice.slice_type === targetSliceId) {
      return {
        slice_type: 'shared_section',
        slice_label: null,
        version: 'initial',
        variation: 'default',
        items: [],
        primary: {
          shared_section: sharedSectionRef
        }
      };
    }
    return slice;
  });
  doc.data.slices = updatedSlices;
  return doc;
}

function saveDoc(doc, folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, `${doc.id}.json`), JSON.stringify(doc, null, 2));
}

(async () => {
  const repo = await ask('Enter your Prismic repository ID');
  const baseDocId = await ask('Enter the base document ID (e.g., en-us homepage)');

  const baseDoc = await fetchDocById(repo, baseDocId);
  console.log(`✅ Retrieved base document: ${baseDoc.uid}`);

  const langPrefix = await ask('Enter the language prefix (e.g., "en")');
  const alternates = getMatchingAlternates(baseDoc.alternate_languages || [], langPrefix);
  console.log(`🔍 Found ${alternates.length} matching documents.`);
alternates.forEach(alt => console.log(`- uid: ${alt.uid} | lang: ${alt.lang}`));

  const docIds = alternates.map(alt => alt.id);

  const sliceToReplace = await ask('Enter the slice ID to replace (e.g., homepage_boxes)');
  const sharedDocId = await ask('Enter the Shared Section document ID');
  const sharedDoc = await fetchDocById(repo, sharedDocId);

  const sharedPreview = summarizeSharedDoc(sharedDoc);
  console.log(`🧩 Shared Section content preview:\n${sharedPreview}\n`);

  console.log(`📋 Preparing documents:`);
  const docsToUpdate = [];
  for (const id of docIds) {
    const doc = await fetchDocById(repo, id);
    const count = countSlices(doc, sliceToReplace);
    console.log(`${doc.id} | ${doc.uid} | ${count}`);
    docsToUpdate.push(doc);
  }

  const confirm = await ask('Proceed with replacing slices and saving files? (yes/no)');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('❌ Operation cancelled.');
    rl.close();
    return;
  }

  const sharedSectionRef = extractSharedSectionRef(sharedDoc);

  console.log('🔄 Replacing and saving updated documents...');
  for (const doc of docsToUpdate) {
    const updatedDoc = replaceSlices(doc, sliceToReplace, sharedSectionRef);
    saveDoc(updatedDoc, './updated_documents');
  }

  console.log('✅ All updated JSONs saved to ./updated_documents');

  const pushConfirm = await ask('Do you want to push these updates to the repository using the Migration API? (yes/no)');
  if (pushConfirm.toLowerCase() === 'yes') {
    const migrationToken = await ask('Enter your Migration API token');

    for (const doc of docsToUpdate) {
      const payload = {
        uid: doc.uid,
        data: doc.data,
        title: doc.slugs[0] || '',
        tags: doc.tags || []
      };

      const response = await fetch(`https://migration.prismic.io/documents/${doc.id}/`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${migrationToken}`,
          'Content-Type': 'application/json',
          'repository': repo,
          'x-api-key': `cSaZlfkQlF9C6CEAM2Del6MNX9WonlV86HPbeEJL`
        },
        body: JSON.stringify(payload)
      });

      // Respect rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (response.ok) {
        console.log(`✅ Successfully updated document ${doc.id}`);
      } else {
        const errorBody = await response.text();
        console.error(`❌ Failed to update document ${doc.id}:`, errorBody);
      }
    }
  } else {
    console.log('📝 Skipped pushing updates to Prismic. You can manually review and publish them later.');
  }

  console.log(`📎 Review updated documents in the Migration Release: https://${repo}.prismic.io/builder/migration`);
  rl.close();
})();
