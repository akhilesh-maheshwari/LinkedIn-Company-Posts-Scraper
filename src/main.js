import { Actor } from 'apify';

await Actor.init();

try {

  // ──────────────────────────────
  // 1. GET INPUT
  // ──────────────────────────────
  const input          = await Actor.getInput();
  const serviceTagName = input.fileName      || '';
  const rawCompanies   = Array.isArray(input.companies) ? input.companies : [];
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
  console.log('Raw Companies  :', rawCompanies.length);
  console.log('Max Posts      :', maxPosts);
  console.log('After Date     :', postsAfterDate || 'All');
  console.log('Include Reposts:', includeReposts);
  console.log('Order ID       :', orderId || 'N/A');

  if (!serviceTagName.trim()) throw new Error('fileName is required!');
  if (!rawCompanies.length)   throw new Error('At least one company URL, username, or name is required!');

  // ──────────────────────────────
  // 2. NORMALIZE COMPANY INPUTS
  // ──────────────────────────────
  const resolvedCompanies = rawCompanies
    .map(c => {
      if (typeof c !== 'string') return null;
      c = c.trim();
      if (!c) return null;

      // Markdown link — extract URL
      const mdMatch = c.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
      if (mdMatch) c = mdMatch[1].trim();

      // Full LinkedIn company URL
      if (
        c.startsWith('https://www.linkedin.com/company/') ||
        c.startsWith('http://www.linkedin.com/company/')
      ) {
        return { type: 'url', value: c };
      }

      // Looks like a URL but wrong path — skip
      if (c.startsWith('http://') || c.startsWith('https://')) {
        console.log(`  ⚠️ Skipping invalid URL: ${c}`);
        return null;
      }

      // No spaces = treat as username/slug
      if (!c.includes(' ')) {
        return { type: 'username', value: c };
      }

      // Has spaces = treat as company name
      return { type: 'name', value: c };
    })
    .filter(Boolean);

  console.log('Resolved companies:', resolvedCompanies.length);
  if (!resolvedCompanies.length) throw new Error('No valid company inputs found!');

  // Build canonical URL or identifier string per entry
  const companyList = resolvedCompanies.map(c => {
    if (c.type === 'url')      return c.value;
    if (c.type === 'username') return `https://www.linkedin.com/company/${c.value}`;
    return c.value; // name — backend handles search
  });

  const rowCount   = companyList.length;
  const csvContent = 'Company\n' + companyList.join('\n');
  const fileName   = serviceTagName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';

  console.log('CSV preview:\n', csvContent.split('\n').slice(0, 4).join('\n'));

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
  // 7. STEP 2 — PROCESS BATCHES
  // ──────────────────────────────
  let round              = 0;
  let allOutputLinks     = [];
  let allBatchResults    = [];
  let totalCharged       = 0;
  let totalRowsDelivered = 0;

  const getNextBatchJobs = async () => {
    try {
      const wf2Res = await fetch(
        'https://frontend.boomerangserver.co.in/webhook/universal_batch_process',
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal : AbortSignal.timeout(300000),
          body   : JSON.stringify({
            request_unique_id,
            batchFolderId,
            userId,
            runId,
            time,
            serviceTagName,
            rowCount,
            creditsCost,
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
      const wf2Text = await wf2Res.text();
      console.log('n8n step 2 status  :', wf2Res.status);
      console.log('n8n step 2 response:', wf2Text);
      if (!wf2Text || wf2Text.trim() === '') return null;
      const wf2Data = JSON.parse(wf2Text);
      return wf2Data.batchJobs || null;
    } catch (err) {
      console.log('❌ No response, please try again.');
      return null;
    }
  };

  let batchJobs = await getNextBatchJobs();

  let retryCount    = 0;
  const MAX_RETRIES = 23;

  while (!batchJobs || batchJobs.length === 0) {
    retryCount++;
    if (retryCount > MAX_RETRIES) {
      throw new Error(`No batch slots available after ${MAX_RETRIES} retries (45 min). Please try again later.`);
    }
    console.log(`⏳ No slots available (backend full). Waiting 2 mins before retry ${retryCount}/${MAX_RETRIES}...`);
    await new Promise(r => setTimeout(r, 2 * 60 * 1000));
    batchJobs = await getNextBatchJobs();
  }

  while (batchJobs && batchJobs.length > 0) {

    round++;
    console.log(`\n════════════════════════════════════`);
    console.log(`Step 2 : Round ${round} — ${batchJobs.length} batch(es)`);
    console.log(`         Processed so far : ${allBatchResults.length}/${total_batches}`);
    console.log(`════════════════════════════════════`);

    const batchStatusResults = await Promise.all(
      batchJobs.map(async (job) => {
        const { request_id, driveInputLink, batch_number } = job;
        console.log(`  ⏳ Batch ${batch_number} — Polling status (request_id: ${request_id})...`);

        const maxAttempts  = 20;
        const pollInterval = 180000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const statusRes = await fetch(
              'https://frontend.boomerangserver.co.in/webhook/Status_and_output_universal_flow',
              {
                method : 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal : AbortSignal.timeout(300000),
                body   : JSON.stringify({
                  request_id,
                  batch_number,
                  driveInputLink,
                  request_unique_id,
                  batchFolderId,
                  boomerangStatUrl,
                  userId,
                  runId,
                  time,
                  serviceTagName,
                  rowCount   : job.batch_size || rowCount,
                  creditsCost
                })
              }
            );
            const statusText = await statusRes.text();

            if (statusText.includes('<html>') || statusText.includes('504')) {
              console.log(`  ⚠️ Batch ${batch_number} — 504, retrying (${attempt}/${maxAttempts})...`);
              await new Promise(r => setTimeout(r, pollInterval));
              continue;
            }

            const statusData = JSON.parse(statusText);
            console.log(`  Batch ${batch_number} full response:`, JSON.stringify(statusData));
            console.log(`  ✅ Batch ${batch_number} status:`, statusData.status);

            if (statusData.status === 'Completed' || statusData.status === 'Failed') {
              return { ...statusData, job };
            }

            console.log(`  🔄 Batch ${batch_number} still processing, attempt ${attempt}/${maxAttempts}. Waiting 3 min...`);
            await new Promise(r => setTimeout(r, pollInterval));

          } catch (err) {
            console.log(`  ⚠️ Batch ${batch_number} poll error (attempt ${attempt}): ${err.message}`);
            await new Promise(r => setTimeout(r, pollInterval));
          }
        }

        console.log(`  ❌ Batch ${batch_number} timed out after ${maxAttempts} attempts.`);

        try {
          await fetch(
            'https://frontend.boomerangserver.co.in/webhook/Status_and_output_universal_flow',
            {
              method : 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal : AbortSignal.timeout(300000),
              body   : JSON.stringify({
                userId, runId, time, serviceTagName,
                rowCount          : job.batch_size || rowCount,
                creditsCost,
                request_id,
                requestStatus     : 'Error',
                driveInputLink,
                boomerangOutputUrl: `https://linkedinprivate-n8n.boomerangserver.co.in/webhook/company-posts-output?request_id=${request_id}`,
                batch_number,
                request_unique_id,
                batchFolderId,
                service_option_1  : serviceOption1,
                service_name      : serviceName,
                request_source    : requestSource,
                reason            : `Timed out after ${maxAttempts} attempts`
              })
            }
          );
          console.log(`  📤 Batch ${batch_number} — Error status sent to webhook.`);
        } catch (err) {
          console.log(`  ⚠️ Batch ${batch_number} — Failed to notify webhook: ${err.message}`);
        }

        return { status: 'Error', job };
      })
    );

    const hasTimeout = batchStatusResults.some(r => r.status === 'GatewayTimeout');
    if (hasTimeout) {
      console.log('\n❌ 504 Gateway Timeout — stopping. Please try again.');
      break;
    }

    const batchResults = [];

    for (const result of batchStatusResults) {
      const { job } = result;
      const { request_id, driveInputLink, batch_number } = job;

      if (result.status !== 'Completed') {
        console.log(`  ⚠️ Batch ${batch_number} did not complete. Skipping output.`);
        batchResults.push({ batch_number, request_id, status: result.status || 'Error', rows_found: 0, output_url: '' });
        allOutputLinks.push('');
        continue;
      }

      const boomerangOutputUrl = `https://linkedinprivate-n8n.boomerangserver.co.in/webhook/company-posts-output?request_id=${request_id}`;

      let outputLink = '';
      try {
        const outputRes = await fetch(
          'https://frontend.boomerangserver.co.in/webhook/Status_and_output_universal_flow',
          {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal : AbortSignal.timeout(60000),
            body   : JSON.stringify({
              userId, runId, time, serviceTagName,
              rowCount         : job.batch_size || rowCount,
              creditsCost,
              request_id,
              requestStatus    : result.status,
              driveInputLink,
              boomerangOutputUrl,
              batch_number,
              request_unique_id,
              batchFolderId,
              service_option_1 : serviceOption1,
              service_name     : serviceName,
              request_source   : requestSource
            })
          }
        );
        const outputText = await outputRes.text();
        console.log(`  Batch ${batch_number} output raw response:`, outputText);
        if (outputRes.ok) {
          try {
            const outputData = JSON.parse(outputText);
            outputLink = outputData['Output Link'] || outputData.outputLink || outputData.driveOutputLink || outputData.webViewLink || '';
          } catch (e) {
            console.log(`  Batch ${batch_number} output parse failed.`);
          }
        }
      } catch (fetchErr) {
        console.log(`  ❌ No response, please try again.`);
      }

      batchResults.push({ batch_number, request_id, status: result.status, rows_found: result.rows_found || 0, output_url: outputLink });
      allOutputLinks.push(outputLink);

      // ──────────────────────────────
      // CHARGE-AFTER-DELIVERY
      // ──────────────────────────────
      let rowsPushed = 0;
      if (outputLink) {
        rowsPushed = await fetchAndPushDriveData(outputLink, batch_number);
      } else {
        console.log(`  ⚠️ Batch ${batch_number} — No output link, skipping Drive fetch and charge.`);
      }

      if (rowsPushed > 0) {
        totalRowsDelivered += rowsPushed;
        const batchCost     = parseFloat((rowsPushed * 0.002).toFixed(3));
        totalCharged       += batchCost;
        console.log(`  💳 Batch ${batch_number} — Charging for ${rowsPushed} rows ($${batchCost}). Total charged: $${totalCharged.toFixed(3)}`);
        try {
          await Actor.charge({ eventName: serviceOption1, count: rowsPushed });
        } catch (chargeErr) {
          const remainingLeads = rowCount - totalRowsDelivered;
          const remainingCost  = parseFloat((remainingLeads * 0.002).toFixed(3));
          console.log(`\n❌ Insufficient Apify credits — run stopped.`);
          console.log(`✅ Posts delivered    : ${totalRowsDelivered}`);
          console.log(`💳 Total charged      : $${totalCharged.toFixed(3)}`);
          console.log(`⏳ Remaining posts    : ${remainingLeads} (needs $${remainingCost} more)`);
          console.log(`👉 Add funds at apify.com/billing and re-run to get remaining posts.`);
          await Actor.exit('Insufficient credits. Add funds at apify.com/billing and re-run.');
        }
      } else {
        console.log(`  ⚠️ Batch ${batch_number} — 0 rows pushed, skipping charge.`);
      }
    }

    console.log(`\n✅ Round ${round} Results:`);
    for (const result of batchResults) {
      console.log(`\n   📦 Batch ${result.batch_number}`);
      console.log(`      Request ID  : ${result.request_id}`);
      console.log(`      Status      : ${result.status}`);
      console.log(`      Output Link : ${result.output_url}`);
    }

    allBatchResults = allBatchResults.concat(batchResults);

    console.log(`\n⏳ Checking for next pending batch...`);
    batchJobs = await getNextBatchJobs();

    if (!batchJobs || batchJobs.length === 0) {
      console.log('✅ No more pending batches — all done!');
      break;
    }
  }

  // ──────────────────────────────
  // 8. FINAL SUMMARY
  // ──────────────────────────────
  const completedCount = allBatchResults.filter(b => b.status === 'Completed').length;
  const errorCount     = allBatchResults.filter(b => b.status !== 'Completed').length;

  console.log('\n════════════════════════════════════');
  console.log('🎉 ALL BATCHES COMPLETED!');
  console.log('════════════════════════════════════');
  console.log('Run ID          :', runId);
  console.log('Total Processed :', allBatchResults.length);
  console.log('Completed       :', completedCount);
  console.log('Errors          :', errorCount);
  console.log('Total Charged   : $', totalCharged.toFixed(3));
  console.log('Total Posts     :', totalRowsDelivered);
  console.log('\nOutput Links:');
  allOutputLinks.forEach((link, i) => console.log(`  Batch ${i + 1} : ${link || 'Failed'}`));
  console.log('════════════════════════════════════');

  // ──────────────────────────────
  // 9. NOTIFY — UPDATE AMOUNT
  // ──────────────────────────────
  const lastCompletedBatch = allBatchResults.filter(b => b.status === 'Completed').slice(-1)[0];
  const lastRequestId      = lastCompletedBatch ? lastCompletedBatch.request_id : '';

  console.log('\n📤 Sending final amount update to webhook...');
  try {
    const updateRes = await fetch(
      'https://frontend.boomerangserver.co.in/webhook/Status_and_output_universal_flow',
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal : AbortSignal.timeout(60000),
        body   : JSON.stringify({
          work_name        : 'update amount',
          request_unique_id,
          request_id       : lastRequestId,
          userId,
          runId,
          time,
          serviceTagName,
          service_name     : serviceName,
          service_option_1 : serviceOption1,
          request_source   : requestSource,
          total_charged    : parseFloat(totalCharged.toFixed(3)),
          total_rows       : totalRowsDelivered,
          completedBatches : completedCount,
          errorBatches     : errorCount,
          totalBatches     : allBatchResults.length,
          orderId
        })
      }
    );
    const updateText = await updateRes.text();
    console.log('Update amount webhook status  :', updateRes.status);
    console.log('Update amount webhook response:', updateText);
  } catch (err) {
    console.log('⚠️ Failed to send amount update webhook:', err.message);
  }

} catch (err) {
  console.log('❌ Error:', err.message);
}

await Actor.exit();
