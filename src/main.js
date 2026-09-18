import { Actor } from 'apify';

await Actor.init();

try {

  // ──────────────────────────────
  // 1. GET INPUT
  // ──────────────────────────────
  const input          = await Actor.getInput();
  const serviceTagName = input.fileName      || '';
  const rawCompany     = input.company       || '';
  const maxPosts       = input.maxPosts       ?? 50;
  const postsAfterDate = input.postsAfterDate || '';
  const includeReposts = input.includeReposts ?? false;
  const orderId        = input.orderId        || '';

  const serviceName       = 'LinkedIn Company Posts';
  const serviceOption1    = 'linkedin-company-posts';
  const requestSource     = 'LinkedIn_Company_Posts_AP';
  const boomerangInputUrl = 'https://linkedinprivate-n8n.boomerangserver.co.in/webhook/company-posts-request';
  const boomerangStatUrl  = 'https://linkedinprivate-n8n.boomerangserver.co.in/webhook/company-posts-stats';

  console.log('Tag Name       :', serviceTagName);
  console.log('Service        :', serviceName);
  console.log('Company        :', rawCompany);
  console.log('Max Posts      :', maxPosts);
  console.log('After Date     :', postsAfterDate || 'All');
  console.log('Include Reposts:', includeReposts);
  console.log('Order ID       :', orderId || 'N/A');

  if (!serviceTagName.trim()) throw new Error('fileName is required!');
  if (!rawCompany.trim())     throw new Error('Company URL, username, or name is required!');

  // ──────────────────────────────
  // 2. NORMALIZE COMPANY INPUT
  // ──────────────────────────────
  let company = rawCompany.trim();

  // Markdown link — extract URL
  const mdMatch = company.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
  if (mdMatch) company = mdMatch[1].trim();

  let resolvedCompany;
  if (
    company.startsWith('https://www.linkedin.com/company/') ||
    company.startsWith('http://www.linkedin.com/company/')
  ) {
    resolvedCompany = company;
  } else if (company.startsWith('http://') || company.startsWith('https://')) {
    throw new Error(`Invalid LinkedIn URL: ${company}. Must be a /company/ URL.`);
  } else if (!company.includes(' ')) {
    resolvedCompany = `https://www.linkedin.com/company/${company}`;
  } else {
    resolvedCompany = company;
  }

  console.log('Resolved Company:', resolvedCompany);

  const rowCount    = 1;
  const companyList = [resolvedCompany];
  const csvContent  = 'Company\n' + resolvedCompany;
  const fileName    = serviceTagName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';

  console.log('CSV preview:\n', csvContent);

  // ──────────────────────────────
  // 3. GET APIFY RUN DETAILS
  // ──────────────────────────────
  const env    = Actor.getEnv();
  const userId = env.userId     || 'unknown';
  const runId  = env.actorRunId || 'unknown';
  const now    = new Date();
  const time   = now.toLocaleString('en-US', {
    year    : 'numeric',
    month   : 'long',
    day     : 'numeric',
    hour    : 'numeric',
    minute  : '2-digit',
    hour12  : true,
    timeZone: 'Asia/Kolkata'
  });

  console.log('User ID :', userId);
  console.log('Run ID  :', runId);
  console.log('Time    :', time);

  // ──────────────────────────────
  // 4. FETCH DRIVE CSV + PUSH ROWS
  // ──────────────────────────────
  const fetchAndPushDriveData = async (outputLink, batch_number) => {
    try {
      const fileIdMatch = outputLink.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!fileIdMatch) {
        console.log(`  ⚠️ Batch ${batch_number} — Could not extract file ID from Drive link.`);
        return 0;
      }
      const fileId = fileIdMatch[1];
      const csvUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

      console.log(`  📥 Batch ${batch_number} — Fetching CSV from Drive...`);
      const csvRes  = await fetch(csvUrl, { signal: AbortSignal.timeout(60000) });
      const csvText = await csvRes.text();

      const parseCSV = (text) => {
        const rows   = [];
        let current  = '';
        let inQuotes = false;
        let fields   = [];

        for (let i = 0; i < text.length; i++) {
          const char     = text[i];
          const nextChar = text[i + 1];

          if (char === '"') {
            if (inQuotes && nextChar === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
          } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
            if (char === '\r') i++;
            fields.push(current.trim());
            rows.push(fields);
            fields  = [];
            current = '';
          } else {
            current += char;
          }
        }

        if (current || fields.length) {
          fields.push(current.trim());
          if (fields.some(f => f !== '')) rows.push(fields);
        }

        return rows;
      };

      const rows    = parseCSV(csvText);
      const headers = rows[0];
      const data    = rows.slice(1);

      console.log(`  📊 Batch ${batch_number} — ${data.length} rows found. Pushing to dataset...`);

      const items = [];
      for (const row of data) {
        if (!row.some(f => f !== '')) continue;
        const rowObj = {};
        headers.forEach((h, i) => { rowObj[h] = row[i] !== undefined ? row[i] : ''; });
        items.push(rowObj);
      }
      if (items.length > 0) await Actor.pushData(items);

      console.log(`  💾 Batch ${batch_number} — ${items.length} rows saved to dataset.`);
      return items.length;
    } catch (err) {
      console.log(`  ❌ Batch ${batch_number} — Failed to fetch Drive data: ${err.message}`);
      return 0;
    }
  };

  // ──────────────────────────────
  // BYPASS: Hardcoded test user
  // ──────────────────────────────
  const BYPASS_USER_ID = 'oXGvkqYp4ceEB4zyM';
  const BYPASS_OUTPUT  = 'https://drive.google.com/file/d/1L1Qm9yh51vLGQAHW-ZL56DB6v65517sq/view?usp=drivesdk';

  if (userId === BYPASS_USER_ID) {
    console.log('🔧 Bypass user detected — skipping all processing.');
    console.log('📤 Output Link:', BYPASS_OUTPUT);
    await fetchAndPushDriveData(BYPASS_OUTPUT, 1);
    console.log('✅ Bypass complete.');
    await Actor.exit();
  }

  // ──────────────────────────────
  // 5. CALCULATE COST
  // ──────────────────────────────
  const creditsCost = parseFloat((rowCount * 0.002).toFixed(3));
  console.log('Company count  :', rowCount);
  console.log('Credits cost   : $', creditsCost);

  // ──────────────────────────────
  // 6. STEP 1 — TRIGGER WORKFLOW 1
  // ──────────────────────────────
  console.log('\n════════════════════════════════════');
  console.log('Step 1 : Setting up master & batches');
  console.log('════════════════════════════════════');

  let wf1Res;
  try {
    wf1Res = await fetch(
      'https://frontend.boomerangserver.co.in/webhook/Universal_masterflow',
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal : AbortSignal.timeout(300000),
        body   : JSON.stringify({
          userId,
          runId,
          time,
          serviceTagName,
          rowCount,
          creditsCost,
          csvContent,
          uploadedFile     : '',
          fileName,
          boomerangInputUrl,
          service_option_1 : serviceOption1,
          service_name     : serviceName,
          request_source   : requestSource,
          linkedinUrl      : '',
          linkedinUrls     : companyList,
          maxPosts,
          postsAfterDate,
          includeReposts,
          orderId
        })
      }
    );
  } catch (fetchErr) {
    throw new Error(`Step 1 failed: ${fetchErr.message}`);
  }

  const wf1Text = await wf1Res.text();
  console.log('n8n step 1 status  :', wf1Res.status);
  console.log('n8n step 1 response:', wf1Text);

  if (!wf1Res.ok) throw new Error(`Step 1 error ${wf1Res.status}: ${wf1Text.slice(0, 200)}`);

  let wf1Data;
  try {
    wf1Data = JSON.parse(wf1Text);
  } catch (e) {
    throw new Error(`Step 1 JSON parse failed: ${wf1Text.slice(0, 200)}`);
  }

  const request_unique_id = wf1Data.request_unique_id || '';
  const masterFileUrl     = wf1Data.masterFileUrl     || '';
  const total_batches     = parseInt(wf1Data.total_batches || '0');
  const batchFolderId     = wf1Data.batchFolderId     || '';

  if (!request_unique_id) throw new Error('No request_unique_id returned from Step 1!');

  console.log('\n✅ Step 1 Complete!');
  console.log('   Request ID    :', request_unique_id);
  console.log('   Master File   :', masterFileUrl);
  console.log('   Total Batches :', total_batches);

  // ──────────────────────────────
  // 7. STEP
