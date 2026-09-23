/*
 * Process entry for picolibc on 32-bit SPARC Linux.
 *
 * picolibc ships a SPARC startup, and it is for bare metal: it writes the
 * trap base register, the window invalid mask and the processor state
 * register, all of which are privileged and fault in a user process. So
 * this is the Linux one, which is much smaller because the kernel has
 * already done all of that.
 *
 * On entry the kernel has left %sp pointing at a 64-byte register-window
 * save area, with argc immediately above it and the argv pointers above
 * that. Nothing is in the registers.
 */
	.section .text
	.global _start
	.type _start, #function
_start:
	/* The frame chain ends here. */
	mov	%g0, %fp
	/* argc, and argv above it, are the argument. */
	add	%sp, 64, %o0
	/*
	 * A frame of our own before the call. A callee may spill its incoming
	 * arguments into the caller's frame at %sp+68 and up -- which, if we
	 * did not move, is exactly where argv lives.
	 */
	sub	%sp, 96, %sp
	call	__isa_start
	 nop
	/* __isa_start does not return; if it ever did, stop here loudly. */
	unimp	0
	.size _start, . - _start

/*
 * The heap. picolibc's `sbrk` hands out memory between these two symbols
 * and asks the kernel for nothing, so the whole heap is one static region
 * that the loader maps like any other zero-initialised data.
 */
	.section .bss
	.align	16
	.global	__heap_start
	.global	__heap_end
__heap_start:
	.skip	16 * 1024 * 1024
__heap_end:

/* No executable stack: nothing here needs one, and saying so explicitly
   keeps the linker from assuming it. */
	.section .note.GNU-stack,"",@progbits
