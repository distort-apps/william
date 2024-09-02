const { chromium } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'Court House News') => {
  let formattedBody = '';

  if (body) {
    body = body.replace(/^MEXICO CITY \(CN\) —\s*/, '');
    formattedBody += `<p>${body}</p><br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  } else if (link) {
    formattedBody += `<br><br><ul><li><a href='${link}'>Visit article @ ${resource}</a></li></ul>`;
  }

  return formattedBody;
};

const insertArticleIntoDatabase = async (client, article) => {
  await client.query(
    `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      article.id,
      article.slug,
      article.headline,
      article.summary || '',
      article.body || '',
      article.author,
      article.resource,
      article.media,
      article.link,
      new Date(article.date).toISOString()
    ]
  );
};

(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING
  });

  let browser;
  let slugCounter = 0; 
  
  console.log('Connecting to the database...');
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

    await client.query('DELETE FROM "Article" WHERE resource = $1', ['Court House News']);
    console.log('Truncated existing articles with resource "Court House News".');

    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    console.log('Navigating to Court House News section...');
    try {
      await page.goto('https://www.courthousenews.com/author/william-savinar/', {
        waitUntil: 'domcontentloaded',
        timeout: 6000
      });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load Court House News page:', error);
      await browser.close();
      await client.end();
      return;
    }

    const articlesData = await page.$$eval('.item', (items) => {
      const convertDateToUTC = (dateString) => {
        const date = new Date(dateString);
        return date.toISOString();
      };

      return items.map(item => {
        const dateText = item.querySelector('.author-date span')?.innerText.trim().replace(/^\/\s*/, '');
        const dateUTC = convertDateToUTC(dateText);
        const summary = item.querySelector('div.excerpt p.small')?.innerText.trim() || '';
        
        return {
          headline: item.querySelector('h2 a')?.innerText.trim(),
          link: item.querySelector('h2 a')?.href.trim(),
          date: dateUTC,
          summary: summary,
        };
      });
    });

    const articles = [];

    for (const data of articlesData) {
      const slug = `court-house-news-${String.fromCharCode(97 + slugCounter++)}`; // Generate slugs like court-house-news-a, b, c, etc.

      articles.push({
        id: cuid(),
        headline: data.headline,
        link: data.link,
        date: data.date,
        slug: slug,
        resource: 'Court House News',
        summary: data.summary,
        body: '',
        author: 'William Savinar',
        media: data.media || ''
      });
    }

    console.log('Collected headlines and links:', articles);

    for (const article of articles) {
      console.log(`Visiting article: ${article.headline}`);

      let success = false;
      let attempts = 0;
      const maxAttempts = 3;

      while (!success && attempts < maxAttempts) {
        attempts++;
        try {
          await page.goto(article.link, {
            waitUntil: 'domcontentloaded',
            timeout: 6000
          });

          try {
            await page.waitForTimeout(1000);
            const media = await page.$eval(
              'figure.featured-image img',
              img => {
                const src = img.getAttribute('src');
                return src.includes('placeholder.png') ? '' : src;
              }
            );
            article.media = media;
          } catch (error) {
            console.error('Error finding media content: ', error);
            article.media = '';
          }

          try {
            let bodyContent = await page.$$eval('.article-content p', paragraphs =>
              paragraphs.map(p => p.innerText.trim()).join('\n\n')
            );

            bodyContent = bodyContent.replace(/^MEXICO CITY \(CN\) —\s*/, '');

            if (!article.summary) {
              article.summary = bodyContent.split(' ').slice(0, 20).join(' ') + '...';
            }

            article.body = processBody(bodyContent, article.link);
          } catch (err) {
            console.error('Error finding body content: ', err);
            article.body = processBody('', article.link);
          }

          await insertArticleIntoDatabase(client, article);

          success = true;
          console.log(`Collected and saved data for article: ${article.headline}`);
        } catch (error) {
          console.error(
            `Error processing article: ${article.headline}, attempt ${attempts}`,
            error
          );
          if (attempts >= maxAttempts) {
            console.error(`Failed to load article after ${maxAttempts} attempts.`);
          }
        }
      }
    }

    fs.writeFileSync(
      'court-house-news-articles.json',
      JSON.stringify(articles, null, 2)
    );
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
    await client.end();
    console.log('Database connection closed.');
  }
})();
