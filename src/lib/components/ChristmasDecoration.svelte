<script lang="ts">
    // Purely decorative; rendered inside the header on both pages.
</script>

<!-- Christmas Decoration -->
<div class="christmas-decoration">
    <div class="ornament-thread"></div>
    <div class="ornament-shell">
        <svg
            viewBox="0 0 50 60"
            width="50"
            height="60"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <!-- Sparkling Stars -->
            <circle
                class="sparkle s1"
                cx="10"
                cy="35"
                r="1"
                fill="white"
            />
            <circle
                class="sparkle s2"
                cx="40"
                cy="45"
                r="1.2"
                fill="white"
            />
            <circle
                class="sparkle s3"
                cx="15"
                cy="50"
                r="0.8"
                fill="white"
            />
            <circle
                class="sparkle s4"
                cx="35"
                cy="25"
                r="1"
                fill="white"
            />

            <!-- Attachment Ring/Star Base -->
            <circle
                cx="25"
                cy="5"
                r="3"
                stroke="#D4AF37"
                stroke-width="1"
                stroke-opacity="0.8"
            />

            <!-- Tree Shape (3 levels) -->
            <path
                d="M25 10L35 25H15L25 10Z"
                stroke="#D4AF37"
                stroke-width="1.2"
                stroke-opacity="0.9"
            />
            <path
                d="M25 20L40 38H10L25 20Z"
                stroke="#D4AF37"
                stroke-width="1.2"
                stroke-opacity="0.7"
            />
            <path
                d="M25 33L45 55H5L25 33Z"
                stroke="#D4AF37"
                stroke-width="1.2"
                stroke-opacity="0.5"
            />

            <!-- Tree Trunk -->
            <rect
                x="22"
                y="55"
                width="6"
                height="4"
                stroke="#D4AF37"
                stroke-width="1"
                stroke-opacity="0.4"
            />

            <!-- Top Star Decoration -->
            <path
                d="M25 8L26.5 11.5L30 11.5L27 13.5L28.5 17L25 15L21.5 17L23 13.5L20 11.5L23.5 11.5L25 8Z"
                fill="#D4AF37"
                fill-opacity="0.8"
                class="sparkle s1"
            />
        </svg>
    </div>
</div>

<style>
    /* Christmas Decoration Styling */
    .christmas-decoration {
        position: absolute;
        top: 100%; /* Exactly at the bottom border of header */
        margin-top: -1px; /* Align perfectly with the 1px border */
        left: 75%; /* Positioned at 3/4 of the line */
        display: flex;
        flex-direction: column;
        align-items: center;
        transform-origin: top center;
        animation: sway 5s ease-in-out infinite;
        pointer-events: all;
        cursor: pointer;
        z-index: 100;
    }
    .ornament-thread {
        width: 1px;
        height: 80px;
        background: linear-gradient(to bottom, #d4af37, transparent);
        opacity: 0.5;
    }
    .ornament-shell {
        transition: all 0.3s ease;
        filter: drop-shadow(0 0 0px transparent);
    }
    .sparkle {
        animation: sparkle-anim 2s infinite ease-in-out;
        opacity: 0;
    }
    .s1 {
        animation-delay: 0.2s;
    }
    .s2 {
        animation-delay: 0.7s;
    }
    .s3 {
        animation-delay: 1.2s;
    }
    .s4 {
        animation-delay: 1.8s;
    }
    @keyframes sparkle-anim {
        0%,
        100% {
            opacity: 0;
            transform: scale(0);
        }
        50% {
            opacity: 0.8;
            transform: scale(1.2);
        }
    }
    .christmas-decoration:hover .ornament-shell {
        filter: drop-shadow(0 0 12px rgba(255, 255, 255, 0.4));
    }
    .christmas-decoration:hover .sparkle {
        animation-duration: 0.8s;
        opacity: 1;
    }
    .christmas-decoration:hover {
        animation-duration: 1.5s;
    }
    @keyframes sway {
        0% {
            transform: rotate(-6deg);
        }
        50% {
            transform: rotate(6deg);
        }
        100% {
            transform: rotate(-6deg);
        }
    }
</style>
