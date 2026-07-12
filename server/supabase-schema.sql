-- ============================================================
-- Schéma Supabase pour le portfolio de projets Ncréa
-- À exécuter dans Supabase → SQL Editor → New query → Run
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  axis text not null check (axis in ('visuel','uxui','anim2d')),
  why text not null default '',
  logo_url text,
  declinations text[] not null default '{}',
  sketches text[] not null default '{}',
  process_images text[] not null default '{}',
  logo_supports text[] not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Row Level Security : lecture publique, écriture interdite directement
-- (les écritures passent uniquement par le serveur backend, avec la clé "service role"
--  qui contourne RLS — jamais exposée au navigateur).
alter table projects enable row level security;

create policy "Public read access"
  on projects for select
  using (true);

-- Aucune policy d'insert/update/delete : seule la clé service_role (utilisée par le
-- serveur backend uniquement) peut écrire, ce qui protège la table même si la clé
-- "anon" venait à être utilisée par erreur côté client.

-- ============================================================
-- Bucket de stockage pour les images des projets
-- À créer manuellement : Storage → New bucket → nom "project-images" → Public bucket: ON
-- (Le bucket lui-même s'occupe de la lecture publique des images une fois créé "public".)
-- ============================================================
