-- Esquema de savings_db (savings-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cdts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cdts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    account_id uuid NOT NULL,
    number character varying(12) NOT NULL,
    amount numeric(18,2) NOT NULL,
    days integer NOT NULL,
    rate numeric(6,4) NOT NULL,
    gross numeric(18,2) NOT NULL,
    tax numeric(18,2) NOT NULL,
    net numeric(18,2) NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    matures_at timestamp with time zone NOT NULL,
    status character varying(10) NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pockets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pockets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    account_id uuid NOT NULL,
    kind character varying(6) NOT NULL,
    name character varying(40) NOT NULL,
    icon character varying(20) NOT NULL,
    balance numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    earned numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    target numeric(18,2),
    target_date date,
    last_accrual_at timestamp with time zone NOT NULL,
    status character varying(8) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);


--
-- Name: savings_ops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.savings_ops (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    type character varying(16) NOT NULL,
    pocket_id uuid,
    cdt_id uuid,
    amount numeric(18,2) NOT NULL,
    close_pocket boolean DEFAULT false NOT NULL,
    idempotency_key uuid NOT NULL,
    status character varying(10) NOT NULL,
    ledger_transaction_id uuid,
    failure_reason character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pockets PK_0d31625105cd8f2774753d1046d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pockets
    ADD CONSTRAINT "PK_0d31625105cd8f2774753d1046d" PRIMARY KEY (id);


--
-- Name: savings_ops PK_5f15337153572a0278706164bb2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_ops
    ADD CONSTRAINT "PK_5f15337153572a0278706164bb2" PRIMARY KEY (id);


--
-- Name: cdts PK_8d4351919157ba2850572d571ae; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdts
    ADD CONSTRAINT "PK_8d4351919157ba2850572d571ae" PRIMARY KEY (id);


--
-- Name: idx_cdts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdts_user ON public.cdts USING btree (id_user, status);


--
-- Name: idx_pockets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pockets_user ON public.pockets USING btree (id_user, status);


--
-- Name: idx_savings_ops_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_savings_ops_user_status ON public.savings_ops USING btree (id_user, status);


--
-- Name: uq_cdts_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cdts_number ON public.cdts USING btree (number);


--
-- Name: uq_savings_ops_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_savings_ops_idempotency ON public.savings_ops USING btree (idempotency_key);


--
-- PostgreSQL database dump complete
--


