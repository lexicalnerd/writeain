# WriteRain - Collaborative Writing App

A beautiful, real-time collaborative writing application built with Express and Supabase.

## 🚀 Deployment to Vercel

### 1. Push to GitHub
Create a new repository on GitHub and push your code:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### 2. Connect to Vercel
1. Go to [Vercel](https://vercel.com) and click **"Add New" -> "Project"**.
2. Import your GitHub repository.
3. **Crucial:** In the **Environment Variables** section, add your Supabase keys:
   - `SUPABASE_URL`: Your Supabase project URL.
   - `SUPABASE_ANON_KEY`: Your Supabase Anon Key.
4. Click **Deploy**.

---

## ⚡ Supabase Setup Guide

### 1. Create a Project
- Sign up at [Supabase](https://supabase.com).
- Click **"New Project"** and follow the prompts.

### 2. Set up the Database
Go to the **SQL Editor** in your Supabase dashboard and run this script:

```sql
-- Create Tasks Table
create table tasks (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  instructions text,
  checklist jsonb default '[]'::jsonb,
  created_by text,
  status text default 'draft',
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- Create Revisions Table
create table revisions (
  id uuid default gen_random_uuid() primary key,
  task_id uuid references tasks(id) on delete cascade,
  content text,
  author text,
  timestamp timestamp with time zone default timezone('utc'::text, now())
);

-- Create Comments Table
create table comments (
  id uuid default gen_random_uuid() primary key,
  task_id uuid references tasks(id) on delete cascade,
  author text,
  text text,
  timestamp timestamp with time zone default timezone('utc'::text, now())
);
```

### 3. Disable RLS (For Development)
To keep things simple for now, go to each table (**Authentication -> Policies**) and either disable Row Level Security (RLS) or add a "Public Access" policy so everyone can read/write. 
*Note: For a production app, you should set up proper security policies.*

---

## 💻 Local Development

1. Run `npm install`.
2. Set your environment variables locally or update `server.js` with your keys for testing.
3. Run `npm start`.
