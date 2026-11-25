SHELL := /bin/bash

API_ENDPOINT ?= 127.0.0.1:3000
WEB_ENDPOINT ?= 127.0.0.1:3001
API_BASE_URL ?= http://localhost:3000

.PHONY: setup build typecheck web-build lint test run-api run-web dev-web

setup:
	npm ci

typecheck:
	npm run build

web-build:
	npm --workspace @serverlessq/web run build

build: typecheck web-build

lint:
	npm run lint

test:
	npm test

run-api:
	AWS_LAMBDA_HTTP_ENDPOINT=$(API_ENDPOINT) npm --workspace @serverlessq/api start

run-web: web-build
	AWS_LAMBDA_HTTP_ENDPOINT=$(WEB_ENDPOINT) API_BASE_URL=$(API_BASE_URL) npm --workspace @serverlessq/web start

dev-web:
	VITE_API_BASE_URL=$(API_BASE_URL) npm --workspace @serverlessq/web run dev
