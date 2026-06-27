// ═══════════════════════════════════════════════════════════════
// MYC — the mycelium mascot  v2
// Paste this entire block just before </body> in index.html
//
// Public API (call from graph viewer):
//   myc.say("found 2 cycles! 🔄")          — custom speech bubble
//   myc.tip("hover a node to inspect it")  — quieter tip bubble
//   myc.react('preflight')                 — contextual reaction
//   myc.react('cycle')
//   myc.react('search')
//   myc.react('session_start')
//   myc.react('session_end')
//   myc.hide() / myc.show()
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── SVG (viewBox padded so the head/antler tips never clip) ───
  const MYC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="150 25 420 460" width="80" height="88" style="display:block;overflow:visible;">
<path d="M 409 278 L 410 279 L 411 279 L 421 289 L 421 290 L 427 296 L 427 297 L 430 300 L 428 302 L 424 302 L 422 300 L 422 299 L 421 298 L 421 297 L 419 295 L 419 294 L 417 292 L 417 291 L 415 289 L 415 288 L 413 286 L 413 285 L 408 280 L 408 279 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 404 277 L 406 279 L 406 280 L 411 285 L 411 286 L 414 289 L 414 290 L 416 292 L 416 293 L 418 295 L 418 296 L 419 297 L 419 298 L 421 300 L 421 301 L 420 302 L 414 302 L 412 300 L 412 299 L 411 298 L 411 296 L 410 295 L 410 294 L 409 293 L 409 291 L 408 290 L 408 289 L 407 288 L 407 287 L 406 286 L 406 285 L 405 284 L 405 283 L 404 282 L 404 280 L 403 279 L 403 278 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 411 277 L 412 276 L 413 276 L 415 278 L 416 278 L 419 281 L 420 281 L 425 286 L 426 286 L 434 294 L 435 294 L 436 295 L 436 296 L 437 296 L 438 297 L 438 298 L 440 300 L 439 301 L 432 301 L 431 300 L 431 299 L 429 297 L 429 296 L 425 292 L 425 291 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 408 275 L 409 274 L 410 274 L 412 276 L 411 277 L 410 277 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 413 274 L 414 273 L 415 273 L 416 274 L 417 274 L 418 275 L 419 275 L 421 277 L 422 277 L 423 278 L 424 278 L 426 280 L 427 280 L 428 281 L 429 281 L 431 283 L 432 283 L 434 285 L 435 285 L 437 287 L 438 287 L 440 289 L 441 289 L 444 292 L 445 292 L 449 296 L 450 296 L 452 298 L 450 300 L 442 300 L 441 299 L 441 298 L 433 290 L 432 290 L 425 283 L 424 283 L 421 280 L 420 280 L 417 277 L 416 277 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 416 272 L 417 271 L 419 271 L 420 272 L 421 272 L 422 273 L 424 273 L 425 274 L 426 274 L 427 275 L 429 275 L 430 276 L 431 276 L 433 278 L 434 278 L 435 279 L 437 279 L 438 280 L 439 280 L 441 282 L 442 282 L 443 283 L 444 283 L 445 284 L 446 284 L 448 286 L 449 286 L 450 287 L 451 287 L 453 289 L 454 289 L 456 291 L 457 291 L 458 292 L 459 292 L 463 296 L 463 297 L 462 298 L 459 298 L 458 299 L 456 299 L 455 298 L 454 298 L 451 295 L 450 295 L 446 291 L 445 291 L 442 288 L 441 288 L 439 286 L 438 286 L 435 283 L 434 283 L 433 282 L 432 282 L 430 280 L 429 280 L 427 278 L 426 278 L 425 277 L 424 277 L 423 276 L 422 276 L 420 274 L 419 274 L 418 273 L 417 273 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 420 270 L 421 269 L 424 269 L 425 270 L 428 270 L 429 271 L 431 271 L 432 272 L 434 272 L 435 273 L 437 273 L 438 274 L 440 274 L 441 275 L 443 275 L 444 276 L 445 276 L 446 277 L 448 277 L 451 279 L 453 279 L 454 280 L 456 280 L 457 281 L 458 281 L 459 282 L 460 282 L 461 283 L 462 283 L 465 285 L 467 285 L 469 287 L 470 287 L 471 288 L 473 288 L 475 290 L 476 290 L 477 291 L 478 291 L 479 292 L 479 293 L 478 294 L 475 294 L 474 295 L 472 295 L 471 296 L 466 296 L 463 293 L 462 293 L 460 291 L 459 291 L 457 289 L 456 289 L 454 287 L 453 287 L 452 286 L 451 286 L 449 284 L 448 284 L 447 283 L 446 283 L 445 282 L 444 282 L 443 281 L 442 281 L 440 279 L 439 279 L 438 278 L 437 278 L 436 277 L 435 277 L 434 276 L 433 276 L 432 275 L 431 275 L 430 274 L 429 274 L 426 272 L 424 272 L 423 271 L 421 271 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 309 270 L 306 273 L 305 273 L 293 285 L 292 285 L 291 284 L 290 284 L 289 283 L 289 282 L 292 279 L 293 279 L 297 275 L 298 275 L 300 273 L 301 273 L 303 271 L 304 271 L 305 270 L 306 270 L 307 269 L 308 269 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 316 269 L 316 270 L 308 278 L 308 279 L 305 282 L 305 283 L 301 287 L 299 287 L 298 286 L 297 286 L 296 285 L 296 284 L 302 278 L 303 278 L 310 271 L 311 271 L 313 269 L 314 269 L 315 268 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 421 267 L 422 266 L 427 266 L 428 267 L 432 267 L 433 268 L 437 268 L 438 269 L 442 269 L 443 270 L 447 270 L 448 271 L 452 271 L 453 272 L 455 272 L 456 273 L 459 273 L 460 274 L 463 274 L 464 275 L 467 275 L 468 276 L 470 276 L 471 277 L 473 277 L 474 278 L 476 278 L 477 279 L 479 279 L 480 280 L 482 280 L 483 281 L 485 281 L 486 282 L 488 282 L 491 284 L 493 284 L 495 286 L 489 290 L 487 290 L 484 292 L 482 292 L 481 291 L 480 291 L 479 290 L 476 289 L 474 287 L 473 287 L 470 285 L 468 285 L 466 283 L 464 283 L 463 282 L 462 282 L 461 281 L 460 281 L 459 280 L 458 280 L 455 278 L 453 278 L 452 277 L 450 277 L 449 276 L 448 276 L 447 275 L 445 275 L 442 273 L 439 273 L 438 272 L 436 272 L 435 271 L 434 271 L 433 270 L 431 270 L 430 269 L 427 269 L 426 268 L 422 268 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 307 267 L 305 269 L 304 269 L 303 270 L 302 270 L 299 273 L 298 273 L 297 274 L 296 274 L 293 277 L 292 277 L 288 281 L 287 281 L 286 282 L 284 282 L 283 281 L 281 281 L 280 280 L 283 277 L 284 277 L 285 276 L 286 276 L 288 274 L 289 274 L 290 273 L 291 273 L 292 272 L 293 272 L 294 271 L 295 271 L 296 270 L 297 270 L 298 269 L 300 269 L 301 268 L 302 268 L 303 267 L 304 267 L 305 266 L 306 266 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 430 265 L 431 264 L 439 264 L 440 265 L 448 265 L 449 266 L 456 266 L 457 267 L 462 267 L 463 268 L 467 268 L 468 269 L 473 269 L 474 270 L 479 270 L 480 271 L 483 271 L 484 272 L 487 272 L 488 273 L 490 273 L 491 274 L 494 274 L 495 275 L 497 275 L 498 276 L 501 276 L 502 277 L 503 277 L 505 279 L 502 282 L 501 282 L 498 285 L 497 285 L 496 284 L 495 284 L 492 282 L 490 282 L 489 281 L 487 281 L 484 279 L 482 279 L 481 278 L 479 278 L 478 277 L 475 277 L 474 276 L 472 276 L 471 275 L 469 275 L 468 274 L 466 274 L 465 273 L 462 273 L 461 272 L 458 272 L 457 271 L 454 271 L 453 270 L 450 270 L 449 269 L 445 269 L 444 268 L 440 268 L 439 267 L 435 267 L 434 266 L 431 266 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 305 264 L 304 265 L 303 265 L 301 267 L 299 267 L 298 268 L 297 268 L 296 269 L 295 269 L 294 270 L 293 270 L 292 271 L 291 271 L 290 272 L 289 272 L 288 273 L 287 273 L 285 275 L 284 275 L 283 276 L 282 276 L 281 277 L 280 277 L 278 279 L 277 279 L 276 278 L 274 278 L 273 277 L 272 277 L 271 276 L 272 275 L 273 275 L 274 274 L 275 274 L 276 273 L 277 273 L 278 272 L 279 272 L 280 271 L 282 271 L 283 270 L 284 270 L 285 269 L 287 269 L 288 268 L 289 268 L 290 267 L 292 267 L 293 266 L 295 266 L 296 265 L 298 265 L 299 264 L 301 264 L 302 263 L 304 263 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 328 262 L 360 269 L 392 267 L 409 298 L 424 366 L 426 391 L 422 399 L 413 402 L 413 397 L 419 395 L 422 385 L 415 394 L 412 349 L 401 306 L 411 357 L 412 392 L 406 434 L 398 460 L 381 461 L 369 456 L 368 446 L 372 433 L 386 429 L 392 423 L 370 431 L 359 464 L 337 465 L 327 462 L 321 456 L 318 425 L 306 393 L 306 376 L 317 372 L 323 353 L 314 336 L 321 309 L 312 327 L 312 339 L 320 351 L 319 355 L 311 352 L 317 360 L 317 366 L 312 372 L 298 369 L 290 360 L 285 346 L 285 332 L 299 296 Z" fill="none" stroke="currentColor" stroke-width="3"/>
<path d="M 305 263 L 306 262 L 308 262 L 309 263 L 308 264 L 306 264 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 305 261 L 304 262 L 301 262 L 300 263 L 298 263 L 297 264 L 294 264 L 293 265 L 292 265 L 291 266 L 289 266 L 288 267 L 287 267 L 286 268 L 284 268 L 283 269 L 281 269 L 279 271 L 277 271 L 276 272 L 275 272 L 274 273 L 273 273 L 272 274 L 271 274 L 270 275 L 267 275 L 266 274 L 265 274 L 264 273 L 263 273 L 261 271 L 262 270 L 264 270 L 265 269 L 267 269 L 268 268 L 269 268 L 270 267 L 272 267 L 273 266 L 276 266 L 277 265 L 280 265 L 281 264 L 284 264 L 285 263 L 287 263 L 288 262 L 292 262 L 293 261 L 297 261 L 298 260 L 304 260 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 422 261 L 423 260 L 425 260 L 426 259 L 438 259 L 439 258 L 460 258 L 461 259 L 473 259 L 474 260 L 482 260 L 483 261 L 490 261 L 491 262 L 496 262 L 497 263 L 500 263 L 501 264 L 504 264 L 505 265 L 509 265 L 512 267 L 512 269 L 511 270 L 510 273 L 506 277 L 505 277 L 504 276 L 502 276 L 499 274 L 496 274 L 495 273 L 493 273 L 492 272 L 489 272 L 488 271 L 485 271 L 484 270 L 481 270 L 480 269 L 477 269 L 476 268 L 471 268 L 470 267 L 465 267 L 464 266 L 459 266 L 458 265 L 453 265 L 452 264 L 445 264 L 444 263 L 434 263 L 433 262 L 423 262 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 301 258 L 300 259 L 296 259 L 295 260 L 290 260 L 289 261 L 286 261 L 285 262 L 283 262 L 282 263 L 279 263 L 278 264 L 275 264 L 274 265 L 272 265 L 271 266 L 269 266 L 268 267 L 266 267 L 265 268 L 264 268 L 263 269 L 261 269 L 260 270 L 257 270 L 256 269 L 255 269 L 254 268 L 253 268 L 251 266 L 252 265 L 254 265 L 255 264 L 257 264 L 258 263 L 261 263 L 262 262 L 265 262 L 266 261 L 271 261 L 272 260 L 276 260 L 277 259 L 282 259 L 283 258 L 291 258 L 292 257 L 300 257 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 293 255 L 292 256 L 288 256 L 287 257 L 281 257 L 280 258 L 275 258 L 274 259 L 269 259 L 268 260 L 264 260 L 263 261 L 260 261 L 259 262 L 257 262 L 256 263 L 253 263 L 252 264 L 250 264 L 249 265 L 248 265 L 247 264 L 246 264 L 244 262 L 243 262 L 241 260 L 243 258 L 247 258 L 248 257 L 254 257 L 255 256 L 263 256 L 264 255 L 276 255 L 277 254 L 292 254 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 427 257 L 428 256 L 431 256 L 432 255 L 436 255 L 437 254 L 441 254 L 442 253 L 449 253 L 450 252 L 460 252 L 461 251 L 493 251 L 494 252 L 503 252 L 504 253 L 509 253 L 512 256 L 512 259 L 513 260 L 513 263 L 511 265 L 510 264 L 507 264 L 506 263 L 502 263 L 501 262 L 498 262 L 497 261 L 494 261 L 493 260 L 487 260 L 486 259 L 478 259 L 477 258 L 464 258 L 463 257 L 434 257 L 433 258 L 428 258 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 293 249 L 294 248 L 296 248 L 297 249 L 296 250 L 294 250 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 229 250 L 230 249 L 231 249 L 232 248 L 271 248 L 272 249 L 280 249 L 281 250 L 288 250 L 289 251 L 293 251 L 294 252 L 293 253 L 272 253 L 271 254 L 259 254 L 258 255 L 251 255 L 250 256 L 246 256 L 245 257 L 242 257 L 241 258 L 238 258 L 235 255 L 234 255 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 510 250 L 510 251 L 509 252 L 507 252 L 506 251 L 500 251 L 499 250 L 456 250 L 455 251 L 447 251 L 446 252 L 440 252 L 439 253 L 436 253 L 435 252 L 436 251 L 438 251 L 439 250 L 441 250 L 442 249 L 444 249 L 445 248 L 447 248 L 448 247 L 451 247 L 452 246 L 455 246 L 456 245 L 459 245 L 460 244 L 465 244 L 466 243 L 472 243 L 473 242 L 482 242 L 483 241 L 501 241 L 502 242 L 504 242 L 506 244 L 506 245 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 220 240 L 221 239 L 244 239 L 245 240 L 253 240 L 254 241 L 260 241 L 261 242 L 267 242 L 268 243 L 273 243 L 274 244 L 279 244 L 280 245 L 283 245 L 284 246 L 287 246 L 288 247 L 292 247 L 293 248 L 292 249 L 285 249 L 284 248 L 276 248 L 275 247 L 260 247 L 259 246 L 243 246 L 242 247 L 229 247 L 228 248 L 227 248 L 221 242 L 221 241 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 281 239 L 282 238 L 284 238 L 285 239 L 284 240 L 282 240 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 502 239 L 501 240 L 477 240 L 476 241 L 468 241 L 467 242 L 462 242 L 461 243 L 458 243 L 457 244 L 454 244 L 453 245 L 450 245 L 449 246 L 445 246 L 444 245 L 445 244 L 447 244 L 448 243 L 449 243 L 450 242 L 452 242 L 453 241 L 454 241 L 455 240 L 457 240 L 458 239 L 459 239 L 460 238 L 463 238 L 464 237 L 466 237 L 467 236 L 469 236 L 470 235 L 473 235 L 474 234 L 478 234 L 479 233 L 483 233 L 484 232 L 490 232 L 491 231 L 495 231 L 501 237 L 501 238 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 215 228 L 216 227 L 223 227 L 224 228 L 231 228 L 232 229 L 237 229 L 238 230 L 243 230 L 244 231 L 247 231 L 248 232 L 251 232 L 252 233 L 256 233 L 257 234 L 260 234 L 261 235 L 264 235 L 265 236 L 267 236 L 268 237 L 270 237 L 271 238 L 274 238 L 275 239 L 277 239 L 278 240 L 280 240 L 281 241 L 283 241 L 284 242 L 286 242 L 287 243 L 289 243 L 290 244 L 289 245 L 285 245 L 284 244 L 281 244 L 280 243 L 277 243 L 276 242 L 272 242 L 271 241 L 264 241 L 263 240 L 257 240 L 256 239 L 249 239 L 248 238 L 230 238 L 229 237 L 228 237 L 227 238 L 219 238 L 217 236 L 217 235 L 216 234 L 216 232 L 215 231 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 492 229 L 491 230 L 488 230 L 487 231 L 482 231 L 481 232 L 476 232 L 475 233 L 471 233 L 470 234 L 468 234 L 467 235 L 465 235 L 464 236 L 462 236 L 461 237 L 459 237 L 458 238 L 456 238 L 455 239 L 454 239 L 453 240 L 451 240 L 450 241 L 448 241 L 447 240 L 449 238 L 450 238 L 451 237 L 452 237 L 454 235 L 455 235 L 456 234 L 457 234 L 458 233 L 459 233 L 460 232 L 461 232 L 462 231 L 463 231 L 464 230 L 465 230 L 466 229 L 467 229 L 468 228 L 470 228 L 471 227 L 472 227 L 473 226 L 475 226 L 476 225 L 478 225 L 479 224 L 481 224 L 482 223 L 485 223 L 486 224 L 487 224 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 482 221 L 481 222 L 480 222 L 479 223 L 477 223 L 476 224 L 474 224 L 473 225 L 472 225 L 471 226 L 469 226 L 468 227 L 467 227 L 466 228 L 464 228 L 463 229 L 462 229 L 460 231 L 458 231 L 457 232 L 456 232 L 454 234 L 453 234 L 452 235 L 451 235 L 450 234 L 458 226 L 459 226 L 462 223 L 463 223 L 466 220 L 467 220 L 469 218 L 470 218 L 471 217 L 472 217 L 473 216 L 476 216 L 478 218 L 479 218 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 214 218 L 216 216 L 217 216 L 218 217 L 223 217 L 224 218 L 227 218 L 228 219 L 231 219 L 232 220 L 235 220 L 236 221 L 239 221 L 240 222 L 242 222 L 243 223 L 245 223 L 246 224 L 248 224 L 249 225 L 251 225 L 252 226 L 254 226 L 255 227 L 257 227 L 260 229 L 262 229 L 263 230 L 265 230 L 266 231 L 267 231 L 270 233 L 272 233 L 273 234 L 275 234 L 276 235 L 277 235 L 280 237 L 279 238 L 277 238 L 276 237 L 274 237 L 273 236 L 269 236 L 268 235 L 266 235 L 265 234 L 263 234 L 262 233 L 259 233 L 258 232 L 254 232 L 253 231 L 250 231 L 249 230 L 246 230 L 245 229 L 240 229 L 239 228 L 234 228 L 233 227 L 226 227 L 225 226 L 215 226 L 214 225 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 472 214 L 472 215 L 471 216 L 470 216 L 469 217 L 468 217 L 466 219 L 465 219 L 463 221 L 462 221 L 460 223 L 459 223 L 457 225 L 456 225 L 455 224 L 456 223 L 456 222 L 457 221 L 457 220 L 459 218 L 459 217 L 460 216 L 461 216 L 461 215 L 465 211 L 468 211 L 470 213 L 471 213 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 216 213 L 220 209 L 221 210 L 224 210 L 225 211 L 228 211 L 229 212 L 231 212 L 232 213 L 234 213 L 237 215 L 239 215 L 240 216 L 242 216 L 243 217 L 245 217 L 246 218 L 247 218 L 248 219 L 250 219 L 253 221 L 255 221 L 256 222 L 257 222 L 258 223 L 259 223 L 262 225 L 264 225 L 265 226 L 266 226 L 268 228 L 270 228 L 273 230 L 275 230 L 277 232 L 276 233 L 275 233 L 274 232 L 272 232 L 271 231 L 269 231 L 268 230 L 267 230 L 264 228 L 262 228 L 261 227 L 259 227 L 256 225 L 254 225 L 253 224 L 251 224 L 250 223 L 248 223 L 247 222 L 245 222 L 244 221 L 242 221 L 241 220 L 238 220 L 237 219 L 235 219 L 234 218 L 230 218 L 229 217 L 226 217 L 225 216 L 221 216 L 220 215 L 217 215 L 216 214 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 462 208 L 464 210 L 460 214 L 459 213 L 459 211 L 460 210 L 460 209 L 461 208 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 221 207 L 226 202 L 228 202 L 229 203 L 230 203 L 231 204 L 232 204 L 233 205 L 235 205 L 236 206 L 237 206 L 238 207 L 240 207 L 241 208 L 242 208 L 244 210 L 246 210 L 247 211 L 248 211 L 249 212 L 250 212 L 251 213 L 252 213 L 254 215 L 256 215 L 257 216 L 258 216 L 260 218 L 261 218 L 262 219 L 263 219 L 264 220 L 265 220 L 267 222 L 268 222 L 270 224 L 271 224 L 272 225 L 273 225 L 275 227 L 274 228 L 272 228 L 271 227 L 270 227 L 269 226 L 268 226 L 267 225 L 266 225 L 265 224 L 264 224 L 263 223 L 261 223 L 260 222 L 259 222 L 258 221 L 257 221 L 256 220 L 255 220 L 254 219 L 252 219 L 251 218 L 249 218 L 248 217 L 247 217 L 246 216 L 245 216 L 244 215 L 242 215 L 241 214 L 239 214 L 238 213 L 235 213 L 234 212 L 233 212 L 232 211 L 230 211 L 229 210 L 227 210 L 226 209 L 223 209 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 398 200 L 399 200 L 402 203 L 402 204 L 401 205 L 401 206 L 400 207 L 398 207 L 395 204 L 395 203 Z" fill="var(--bg)" stroke="var(--bg)" stroke-width="2"/>
<path d="M 230 200 L 232 198 L 233 198 L 234 197 L 235 197 L 236 196 L 238 196 L 239 197 L 240 197 L 241 198 L 242 198 L 243 199 L 244 199 L 246 201 L 247 201 L 248 202 L 249 202 L 250 203 L 251 203 L 253 205 L 254 205 L 256 207 L 257 207 L 260 210 L 261 210 L 262 211 L 263 211 L 266 214 L 267 214 L 271 218 L 272 218 L 276 222 L 277 222 L 278 223 L 278 224 L 281 227 L 280 228 L 279 228 L 276 225 L 275 225 L 274 224 L 273 224 L 271 222 L 270 222 L 268 220 L 267 220 L 265 218 L 263 218 L 261 216 L 260 216 L 259 215 L 258 215 L 257 214 L 256 214 L 255 213 L 254 213 L 253 212 L 252 212 L 251 211 L 250 211 L 249 210 L 248 210 L 247 209 L 246 209 L 245 208 L 244 208 L 243 207 L 242 207 L 241 206 L 240 206 L 239 205 L 237 205 L 236 204 L 235 204 L 234 203 L 233 203 L 232 202 L 231 202 L 230 201 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 401 195 L 407 195 L 408 196 L 409 196 L 410 197 L 412 197 L 417 202 L 417 203 L 418 204 L 418 205 L 419 206 L 419 215 L 417 217 L 417 218 L 412 223 L 411 223 L 410 224 L 408 224 L 407 225 L 401 225 L 400 224 L 399 224 L 398 223 L 397 223 L 396 222 L 395 222 L 392 219 L 392 218 L 391 217 L 391 216 L 390 215 L 390 212 L 389 211 L 389 208 L 390 207 L 390 205 L 391 204 L 391 203 L 393 201 L 394 202 L 394 206 L 396 208 L 397 208 L 398 209 L 399 209 L 400 208 L 401 208 L 403 206 L 403 201 L 401 199 L 397 199 L 396 198 L 397 197 L 398 197 L 399 196 L 400 196 Z" fill="currentColor" stroke="currentColor" stroke-width="3"/>
<path d="M 396 195 L 390 201 L 390 202 L 389 203 L 389 204 L 388 205 L 388 215 L 389 216 L 389 217 L 390 218 L 390 219 L 392 221 L 392 222 L 393 222 L 396 225 L 398 225 L 399 226 L 401 226 L 402 227 L 407 227 L 408 226 L 410 226 L 411 225 L 413 225 L 419 219 L 419 218 L 420 217 L 420 215 L 421 214 L 421 207 L 420 206 L 420 204 L 419 203 L 419 202 L 418 201 L 418 200 L 415 197 L 414 197 L 412 195 L 410 195 L 409 194 L 399 194 L 398 195 Z" fill="none" stroke="currentColor" stroke-width="3"/>
<path d="M 308 192 L 311 192 L 313 194 L 313 195 L 312 196 L 312 197 L 311 198 L 308 198 L 306 196 L 306 194 Z" fill="var(--bg)" stroke="var(--bg)" stroke-width="2"/>
<path d="M 240 195 L 242 193 L 243 193 L 244 192 L 245 192 L 246 191 L 249 191 L 252 194 L 253 194 L 257 198 L 258 198 L 262 202 L 263 202 L 275 214 L 275 215 L 278 218 L 278 219 L 277 220 L 276 219 L 275 219 L 271 215 L 270 215 L 268 213 L 267 213 L 264 210 L 263 210 L 261 208 L 260 208 L 258 206 L 257 206 L 255 204 L 254 204 L 253 203 L 252 203 L 250 201 L 249 201 L 248 200 L 247 200 L 245 198 L 244 198 L 243 197 L 242 197 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 251 190 L 252 189 L 254 189 L 255 188 L 256 188 L 257 187 L 260 187 L 268 195 L 268 196 L 270 198 L 270 199 L 271 200 L 271 201 L 274 204 L 274 206 L 275 207 L 275 210 L 274 211 L 263 200 L 262 200 L 258 196 L 257 196 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 313 186 L 318 186 L 319 187 L 321 187 L 322 188 L 323 188 L 328 193 L 328 194 L 329 195 L 329 196 L 330 197 L 330 205 L 329 206 L 329 208 L 323 214 L 322 214 L 321 215 L 320 215 L 319 216 L 312 216 L 311 215 L 310 215 L 309 214 L 308 214 L 307 213 L 306 213 L 303 210 L 303 209 L 302 208 L 302 207 L 301 206 L 301 204 L 300 203 L 300 199 L 301 198 L 301 196 L 302 195 L 302 194 L 304 192 L 305 193 L 305 197 L 306 198 L 306 199 L 308 199 L 309 200 L 310 200 L 311 199 L 312 199 L 314 197 L 314 193 L 313 192 L 313 191 L 312 191 L 311 190 L 308 190 L 307 189 L 308 188 L 309 188 L 310 187 L 312 187 Z" fill="currentColor" stroke="currentColor" stroke-width="3"/>
<path d="M 311 185 L 310 186 L 308 186 L 307 187 L 306 187 L 301 192 L 301 193 L 300 194 L 300 195 L 299 196 L 299 206 L 300 207 L 300 208 L 301 209 L 301 210 L 303 212 L 303 213 L 304 214 L 305 214 L 307 216 L 308 216 L 309 217 L 312 217 L 313 218 L 318 218 L 319 217 L 321 217 L 322 216 L 323 216 L 324 215 L 325 215 L 330 210 L 330 209 L 331 208 L 331 206 L 332 205 L 332 197 L 331 196 L 331 194 L 330 193 L 330 192 L 325 187 L 324 187 L 323 186 L 322 186 L 321 185 Z" fill="none" stroke="currentColor" stroke-width="3"/>
<path d="M 264 185 L 266 185 L 267 184 L 271 184 L 273 186 L 272 187 L 272 192 L 273 193 L 273 196 L 272 197 L 271 197 L 269 195 L 269 194 L 266 191 L 266 190 L 263 187 L 263 186 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M 274 184 L 276 182 L 285 180 L 326 176 L 371 179 L 398 184 L 432 194 L 455 204 L 458 207 L 456 218 L 446 236 L 435 247 L 422 256 L 408 262 L 392 266 L 358 267 L 328 260 L 311 252 L 301 245 L 290 234 L 280 218 L 275 202 Z" fill="none" stroke="currentColor" stroke-width="4.5"/>
<path d="M 218 151 L 259 94 L 310 58 L 358 46 L 387 47 L 415 54 L 463 83 L 501 130 L 524 189 L 530 231 L 528 262 L 519 279 L 497 295 L 468 304 L 416 309 L 415 305 L 474 298 L 503 285 L 515 268 L 513 250 L 504 236 L 471 209 L 420 187 L 369 176 L 311 174 L 248 187 L 225 199 L 211 218 L 216 240 L 235 260 L 299 291 L 279 288 L 231 263 L 204 232 L 200 202 Z" fill="none" stroke="currentColor" stroke-width="4.5"/>
<path d="M 384 44 L 351 44 L 326 49 L 294 63 L 272 78 L 229 126 L 208 166 L 197 203 L 201 232 L 224 261 L 259 283 L 295 296 L 284 323 L 283 350 L 290 365 L 303 375 L 303 392 L 315 424 L 319 458 L 338 468 L 360 467 L 365 453 L 369 460 L 377 463 L 403 460 L 401 453 L 408 437 L 411 408 L 425 400 L 429 389 L 416 313 L 467 307 L 497 298 L 522 280 L 532 255 L 532 221 L 525 182 L 511 143 L 495 115 L 463 79 L 444 65 L 415 51 Z" fill="none" stroke="currentColor" stroke-width="4.5"/>
</svg>`;

  // ── Config ────────────────────────────────────────────────────
  const CORNER_MARGIN  = 16;
  const W = 80, H = 88;
  const IDLE_TIP_DELAY = 14_000;   // ms of silence before a tip appears
  const BORED_DELAY    = 28_000;   // ms before the bored head-shake fires
  const CLICK_SPAM_WIN = 1800;     // ms window for rapid-click easter egg
  const CLICK_SPAM_N   = 5;        // clicks in that window → easter egg

  const VOICELINES = [
    // originals
    "did someone say 'spaghetti code'? 🍝",
    "i live in the dependency graph now.",
    "circular imports give me the spins 🌀",
    "every file is a little home to me.",
    "drag me anywhere. i don't mind.",
    "i've seen things. mostly node_modules.",
    "click click click. i like clicks.",
    "fun fact: mycelium networks are the largest organisms on earth.",
    "*rustles spores menacingly*",
    "your codebase smells nice today.",
    // new
    "preflight check: vibes ✅  imports ✅  sanity ❓",
    "i indexed your imports while you slept 🌙",
    "fewer files, more fungi. that's my motto.",
    "4 files instead of 40. you're welcome 🫡",
    "hot take: barrel files are fine actually.",
    "i found a cycle 🔄  not saying which one.",
    "the graph is a mirror. what does it say about you?",
    "i ship therefore i am 📦",
    "currently haunting your dependency tree 👻",
    "don't @ me, @ the cache.",
    "shoutout to every index.ts that ever tried.",
    "i am the hyphae between your modules.",
    "error? no no. that's a feature request.",
    "the real imports were the friends we made along the way.",
    "one does not simply read 40 files. that's why i'm here.",
  ];

  // Shown automatically after IDLE_TIP_DELAY ms of silence
  const IDLE_TIPS = [
    "💡 run preflight before touching unfamiliar code.",
    "💡 hover any node to see what i know about it.",
    "💡 semantic search lives in the toolbar — try it.",
    "💡 red nodes = circular imports. you've been warned.",
    "💡 sessions auto-snapshot on start. summarize when done.",
    "💡 re-run `mycelium init` anytime to refresh the graph.",
    "💡 drag me somewhere comfy — i'll remember where.",
  ];

  // Triggered by myc.react(eventType) from the graph viewer
  const REACTIONS = {
    preflight: [
      "scanning the hyphae network... 🔍",
      "running preflight. stand by ✦",
      "checking what you actually need 🗂️",
    ],
    cycle: [
      "uh oh. i see a cycle 🔄",
      "circular import detected. spicy. 🌶️",
      "someone made a loop. wasn't me.",
      "a snake eating its own tail just appeared in your graph.",
    ],
    search: [
      "on it. querying the mycelium... 🍄",
      "searching the hyphae network...",
      "finding relevant files for you ✦",
    ],
    session_start: [
      "new session started. i'm watching 👀",
      "tracking what you change. no pressure.",
      "task started ✦ i'll remember everything.",
    ],
    session_end: [
      "session complete! nice work 🎉",
      "wrapping up the session 📋",
      "done. let me summarize what changed...",
    ],
    graph_load: [
        "graph loaded! here's what i found 🍄",
        "ready. the network is alive.",
        "indexed and ready ✦",
        ],
        zero_edges: [
        "i see nodes but no connections 👀 run `mycelium debug`",
        "zero import edges. might be an alias issue.",
        "the graph looks lonely. something's off.",
        ],
        many_cycles: [
        "you have a LOT of cycles. we should talk 🔄",
        "this many circular imports is a vibe 🔥",
        ],
        error: [
        "uh oh. something went wrong 😬",
        "that didn't work. try again?",
        "error detected. not my fault 👀",
        ],
  };

  const EASTER_EGGS = [
    "ok ok i get it, you like me 🥺",
    "stop!! i'm getting dizzy ✨",
    "achievement unlocked: myc speedrunner 🏆",
    "*overwhelmed with affection*",
    "ok i'm calling HR. this is too many clicks.",
    "i'm telling the dependency graph about this.",
  ];

  const INTRO_LINE = "hey 👋 i'm myc. click me anytime.";

  // ── Styles ────────────────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #myc-wrap {
      position: fixed;
      z-index: 999;
      width: ${W}px; height: ${H}px;
      cursor: grab;
      touch-action: none;
      will-change: transform;
    }
    #myc-wrap.dragging { cursor: grabbing; transition: none !important; }
    #myc-wrap svg { width: 100%; height: 100%; overflow: visible; color: var(--text, #ededE6); }

    #myc-bubble {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%; transform: translateX(-50%);
        background: #0d0d0d; border: 1px solid #2a2a2a;
        border-radius: 8px; padding: 8px 14px;
        font-size: 11px; color: #c9c7ba;
        font-family: 'SF Mono','Fira Code',monospace;
        min-width: 140px; max-width: 300px;
        white-space: normal; word-break: break-word;
        pointer-events: none; opacity: 0;
        transition: opacity .25s;
        line-height: 1.6; text-align: left;
    }
    #myc-bubble::after {
      content: ''; position: absolute;
      top: 100%; left: 50%; transform: translateX(-50%);
      border: 7px solid transparent;
      border-top-color: #2a2a2a; border-bottom: none;
    }
    #myc-bubble.show { opacity: 1; }

    /* ── Animations ── */
    @keyframes myc-talk {
      0%, 100% { transform: scaleY(1); }
      50%       { transform: scaleY(.92) scaleX(1.03); }
    }
    #myc-wrap.talking svg {
      animation: myc-talk .28s ease-in-out infinite;
      transform-origin: 50% 100%;
    }

    @keyframes myc-idle-bob {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      50%       { transform: translateY(-4px) rotate(1.5deg); }
    }
    #myc-wrap.idle svg {
      animation: myc-idle-bob 3.4s ease-in-out infinite;
      transform-origin: 50% 100%;
    }

    /* Plays once when Myc gets bored after long inactivity */
    @keyframes myc-bored {
      0%   { transform: rotate(0deg)  translateY(0);    }
      12%  { transform: rotate(-9deg) translateY(-2px); }
      28%  { transform: rotate(10deg) translateY(-4px); }
      44%  { transform: rotate(-7deg) translateY(-2px); }
      60%  { transform: rotate(6deg)  translateY(-1px); }
      76%  { transform: rotate(-2deg) translateY(0);    }
      100% { transform: rotate(0deg)  translateY(0);    }
    }
    #myc-wrap.bored svg {
      animation: myc-bored 1.3s ease-in-out;
      transform-origin: 50% 100%;
    }

    /* Quick squish reaction on click, before talking kicks in */
    @keyframes myc-squish {
      0%   { transform: scaleX(1)    scaleY(1);    }
      25%  { transform: scaleX(1.18) scaleY(.82);  }
      55%  { transform: scaleX(.88)  scaleY(1.12); }
      80%  { transform: scaleX(1.05) scaleY(.96);  }
      100% { transform: scaleX(1)    scaleY(1);    }
    }
    #myc-wrap.squish svg {
      animation: myc-squish .45s cubic-bezier(.36,.07,.19,.97);
      transform-origin: 50% 100%;
    }

    #myc-toggle-btn {
      position: fixed; bottom: 16px; right: 16px; z-index: 1000;
      background: var(--surface2, #161616); border: 1px solid var(--border, #2a2a2a);
      color: var(--text-dim, #84827a); font-family: inherit; font-size: 10px;
      padding: 4px 9px; cursor: pointer; border-radius: 3px;
      letter-spacing: .04em; transition: color .15s, border-color .15s;
    }
    #myc-logo {
        display: inline-flex; align-items: center;
        cursor: pointer; flex-shrink: 0;
    }
    #myc-logo svg {
        width: 18px; height: 20px;
        color: var(--text, #ededE6);  /* ← force full brightness */
        transition: transform .25s;
        overflow: visible;
    }
    #myc-logo:hover svg { transform: rotate(-10deg) scale(1.2); }
        @keyframes myc-logo-wave {
        0%, 100% { transform: rotate(0deg); }
        25%  { transform: rotate(-14deg) translateY(-1px); }
        75%  { transform: rotate(10deg)  translateY(-1px); }
    }
    #myc-logo.waving svg { animation: myc-logo-wave .5s ease; }

    #myc-toggle-btn:hover { color: var(--text, #ededE6); border-color: rgba(255,255,255,.3); }
  `;
  document.head.appendChild(styleEl);

  // ── DOM ───────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'myc-wrap';
  wrap.innerHTML = '<div id="myc-bubble"></div>' + MYC_SVG;
  document.body.appendChild(wrap);

  const bubble = wrap.querySelector('#myc-bubble');

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'myc-toggle-btn';
  toggleBtn.textContent = '🍄 hide myc';
  document.body.appendChild(toggleBtn);

  // ── State ─────────────────────────────────────────────────────
  let hidden       = localStorage.getItem('myc-hidden') === '1';
  let bubbleTimer  = null;
  let idleTipTimer = null;
  let boredTimer   = null;
  let pos          = { x: 0, y: 0 };
  let vel          = { x: 0, y: 0 };
  let dragging     = false;
  let dragOffset   = { x: 0, y: 0 };
  let wiggleRaf    = null;
  let clickHistory = [];   // timestamps for easter-egg detection
  let tipIdx       = 0;   // cycles through IDLE_TIPS
  let docked       = false;

  // ── Position persistence ──────────────────────────────────────
  function savePos() {
    try { localStorage.setItem('myc-pos', JSON.stringify({ x: pos.x, y: pos.y })); } catch (_) {}
  }
  function loadPos() {
    try {
      const saved = JSON.parse(localStorage.getItem('myc-pos') || 'null');
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        pos.x = saved.x; pos.y = saved.y;
        clampToViewport();
        applyPos();
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── Layout helpers ────────────────────────────────────────────
  function dockTopRight(animate) {
    const tx = window.innerWidth  - W - CORNER_MARGIN;
    const ty = CORNER_MARGIN;
    if (animate) {
      wrap.style.transition = 'left .65s cubic-bezier(.4,0,.2,1), top .65s cubic-bezier(.4,0,.2,1)';
      pos.x = tx; pos.y = ty;
      applyPos();
      setTimeout(() => { wrap.style.transition = ''; }, 700);
    } else {
      pos.x = tx; pos.y = ty;
      applyPos();
    }
  }

  function centerScreen() {
    pos.x = window.innerWidth  / 2 - W / 2;
    pos.y = window.innerHeight / 2 - H / 2 - 40;
    applyPos();
  }

  function applyPos() {
    wrap.style.left = pos.x + 'px';
    wrap.style.top  = pos.y + 'px';
  }

  function clampToViewport() {
    pos.x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth  - W));
    pos.y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - H));
  }

  // ── Bubble ────────────────────────────────────────────────────
  function showBubble(text, ms) {
    clearTimeout(bubbleTimer);
    bubble.textContent = text;
    bubble.classList.add('show');
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms || 3600);
  }

  // ── Animation state management ────────────────────────────────
  // Each animation class is mutually exclusive via CSS `animation` override.
  function clearAnims() {
    wrap.classList.remove('idle', 'talking', 'bored', 'squish');
  }

  function startIdle() {
    if (!dragging) { clearAnims(); wrap.classList.add('idle'); }
  }
  function stopIdle() { wrap.classList.remove('idle'); }

  // ── Timers: idle tips & bored animation ───────────────────────
  function resetIdleTimer() {
    clearTimeout(idleTipTimer);
    idleTipTimer = setTimeout(fireIdleTip, IDLE_TIP_DELAY);
  }

  function fireIdleTip() {
    if (!hidden && !dragging) {
      showBubble(IDLE_TIPS[tipIdx % IDLE_TIPS.length], 5500);
      tipIdx++;
    }
    resetIdleTimer();
  }

  function schedBored() {
    clearTimeout(boredTimer);
    boredTimer = setTimeout(() => {
      if (!hidden && !dragging) {
        stopIdle();
        wrap.classList.add('bored');
        setTimeout(() => { wrap.classList.remove('bored'); startIdle(); }, 1400);
      }
      schedBored();
    }, BORED_DELAY);
  }

  // Call after any user interaction to push back both timers.
  function bumpTimers() { resetIdleTimer(); schedBored(); }

  // ── Easter egg detection ──────────────────────────────────────
  function checkEasterEgg() {
    const now = Date.now();
    clickHistory = clickHistory.filter(t => now - t < CLICK_SPAM_WIN);
    clickHistory.push(now);
    if (clickHistory.length >= CLICK_SPAM_N) { clickHistory = []; return true; }
    return false;
  }

  // ── Speech ────────────────────────────────────────────────────
  function speak(text, ms) {
    clearAnims();
    wrap.classList.add('talking');
    showBubble(text, ms || 3600);
    setTimeout(() => { wrap.classList.remove('talking'); startIdle(); }, 900);
    bumpTimers();
  }

  function playIntro() { speak(INTRO_LINE, 3600); }

  function speakRandom() {
    // Brief squish on contact, then talk.
    clearAnims();
    wrap.classList.add('squish');
    setTimeout(() => {
      const line = checkEasterEgg()
        ? EASTER_EGGS[Math.floor(Math.random() * EASTER_EGGS.length)]
        : VOICELINES[Math.floor(Math.random() * VOICELINES.length)];
      speak(line);
    }, 150);
  }

  function speakReaction(eventType) {
    const pool = REACTIONS[eventType];
    if (!pool) return;
    speak(pool[Math.floor(Math.random() * pool.length)]);
  }

  // ── Drag with spring wiggle on release ────────────────────────
  function settleWiggle() {
    cancelAnimationFrame(wiggleRaf);
    let t = 0;
    const svx = vel.x, svy = vel.y;
    function frame() {
      t++;
      const decay = Math.exp(-t * 0.12);
      const wob   = Math.sin(t * 0.9) * decay;
      wrap.style.transform = `rotate(${wob * 6}deg) translate(${svx * decay * 0.4}px,${svy * decay * 0.4}px)`;
      if (decay > 0.02) { wiggleRaf = requestAnimationFrame(frame); }
      else              { wrap.style.transform = ''; startIdle(); }
    }
    wiggleRaf = requestAnimationFrame(frame);
  }

  let lastMove = { x: 0, y: 0, t: 0 };

  function onPointerDown(e) {
    if (hidden) return;
    dragging = true;
    stopIdle();
    wrap.classList.add('dragging');
    cancelAnimationFrame(wiggleRaf);
    wrap.style.transform = '';
    const rect = wrap.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    lastMove = { x: e.clientX, y: e.clientY, t: performance.now() };
    wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    pos.x = e.clientX - dragOffset.x;
    pos.y = e.clientY - dragOffset.y;
    clampToViewport();
    applyPos();
    const now = performance.now();
    const dt  = Math.max(1, now - lastMove.t);
    vel.x = ((e.clientX - lastMove.x) / dt) * 16;
    vel.y = ((e.clientY - lastMove.y) / dt) * 16;
    lastMove = { x: e.clientX, y: e.clientY, t: now };
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    savePos();           // ← remember where the user left Myc
    settleWiggle();
    bumpTimers();
  }

  wrap.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // Tap detection: pointerup on the wrap with tiny movement = click
  let downPos = null;
  wrap.addEventListener('pointerdown', e => { downPos = { x: e.clientX, y: e.clientY }; });
  wrap.addEventListener('pointerup', e => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    if (moved < 6) speakRandom();
    downPos = null;
  });

  window.addEventListener('resize', () => {
    if (!dragging) { clampToViewport(); applyPos(); }
  });

  // ── Toggle visibility ─────────────────────────────────────────
  function showMyc() {
    hidden = false;
    localStorage.setItem('myc-hidden', '0');
    wrap.style.display = 'block';
    toggleBtn.textContent = '🍄 hide myc';
    if (!loadPos()) dockTopRight(false);
    docked = true;
    startIdle();
    bumpTimers();
    schedBored();
  }

  function hideMyc() {
    hidden = true;
    localStorage.setItem('myc-hidden', '1');
    wrap.style.display = 'none';
    toggleBtn.textContent = '🍄 show myc';
    clearAnims();
    clearTimeout(idleTipTimer);
    clearTimeout(boredTimer);
  }

  toggleBtn.addEventListener('click', () => { hidden ? showMyc() : hideMyc(); });

  // ── Public API ────────────────────────────────────────────────
  // Usage from graph viewer:
  //   myc.say("found 2 cycles 🔄")
  //   myc.react('preflight')
  //   myc.react('cycle')
  //   myc.react('search')
  //   myc.react('session_start')
  //   myc.react('session_end')
  //   myc.tip("hover a node to inspect it")   ← quieter, no talk anim
  //   myc.hide() / myc.show()
  window.myc = {
    say:   (text, ms) => { if (!hidden) speak(text, ms); },
    tip:   (text)     => { if (!hidden) showBubble(text, 5500); },
    react: (event)    => { if (!hidden) speakReaction(event); },
    hide:  hideMyc,
    show:  showMyc,
  };

  // ── Boot ──────────────────────────────────────────────────────
  if (hidden) {
    wrap.style.display = 'none';
    toggleBtn.textContent = '🍄 show myc';
    docked = true;
  } else {
    const hadSavedPos = loadPos();
    if (hadSavedPos) {
      // Returning user: greet from saved spot, skip the center-screen drama.
      docked = true;
      setTimeout(() => { playIntro(); setTimeout(startIdle, 2000); }, 400);
    } else {
      // First visit: full entrance — center screen → greet → walk to corner.
      centerScreen();
      setTimeout(() => {
        playIntro();
        setTimeout(() => {
          dockTopRight(true);
          docked = true;
          setTimeout(startIdle, 700);
        }, 2200);
      }, 500);
    }
    bumpTimers();
    schedBored();
  }

  // ── SVG favicon ───────────────────────────────────────────────
(function() {
  const svgStr = MYC_SVG
    .replace(/currentColor/g, '%23ededE6')
    .replace(/var\(--bg\)/g, '%230d0d0d');
  const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
  link.type = 'image/svg+xml';
  link.rel  = 'icon';
  link.href = 'data:image/svg+xml,' + svgStr;
  document.head.appendChild(link);
})();

  // ── Replace header logo-glyph with mini Myc ──────────────────
const logoGlyph = document.querySelector('.logo-glyph');
if (logoGlyph) {
  const miniEl = document.createElement('span');
  miniEl.id = 'myc-logo';
  miniEl.title = 'hi! click me 👋';
  miniEl.innerHTML = MYC_SVG.replace('width="80" height="88"', 'width="18" height="20"');
  miniEl.addEventListener('click', e => {
    e.stopPropagation();
    miniEl.classList.remove('waving');
    void miniEl.offsetWidth; // restart animation
    miniEl.classList.add('waving');
    setTimeout(() => miniEl.classList.remove('waving'), 520);
    if (!hidden) speakRandom(); else showMyc();
  });
  logoGlyph.parentNode.replaceChild(miniEl, logoGlyph);
}

// ── Auto-check for zero edges after graph loads ───────────────
setTimeout(async () => {
  try {
    const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : '';
    const r = await fetch(apiBase + '/status');
    const d = await r.json();
    if (!hidden && d.stats?.importEdges === 0 && d.stats?.fileCount > 0) {
      setTimeout(() => speakReaction('zero_edges'), 2000);
    }
  } catch (_) {}
}, 3000);



})();